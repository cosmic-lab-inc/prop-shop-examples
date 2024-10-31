import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program, Provider } from '@coral-xyz/anchor';
import {
	createAssociatedTokenAccountInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
	ComputeBudgetProgram,
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Signer,
	TransactionError,
	TransactionInstruction,
} from '@solana/web3.js';
import {
	DriftClient,
	DriftClientConfig,
	getUserAccountPublicKey,
	User,
	Wallet,
	WRAPPED_SOL_MINT,
} from '@drift-labs/sdk';
import { IDL, VaultClient } from '@drift-labs/vaults-sdk';
import {
	AsyncSigner,
	buildAndSignTransaction,
	InstructionReturn,
	sendTransaction,
	walletToAsyncSigner,
} from '@cosmic-lab/data-source';
import { err, ok, Result } from 'neverthrow';
import { signatureLink } from '@cosmic-lab/prop-shop-sdk';

async function sendTransactionWithResult(
	instructions: InstructionReturn[],
	funder: AsyncSigner,
	connection: Connection
): Promise<Result<string, TransactionError>> {
	try {
		const tx = await buildAndSignTransaction(instructions, funder, {
			connection,
			commitment: 'confirmed',
		});
		const res = await sendTransaction(tx, connection, {
			sendOptions: {
				skipPreflight: false,
			},
		});
		if (res.value.isErr()) {
			return err(res.value.error);
		} else {
			return ok(res.value.value);
		}
	} catch (e: any) {
		throw new Error(e);
	}
}

export async function sendTx(
	provider: AnchorProvider,
	ixs: TransactionInstruction[],
	signers: Signer[] = []
): Promise<string> {
	const instructions = [
		ComputeBudgetProgram.setComputeUnitLimit({
			units: 400_000,
		}),
		ComputeBudgetProgram.setComputeUnitPrice({
			microLamports: 10_000,
		}),
		...ixs,
	];

	const recentBlockhash = await provider.connection
		.getLatestBlockhash()
		.then((res) => res.blockhash);
	const msg = new anchor.web3.TransactionMessage({
		payerKey: provider.publicKey,
		recentBlockhash,
		instructions,
	}).compileToV0Message();
	let tx = new anchor.web3.VersionedTransaction(msg);
	const signer = walletToAsyncSigner(provider.wallet);
	tx = await signer.sign(tx);
	tx.sign(signers);

	const sim = (
		await provider.connection.simulateTransaction(tx, {
			sigVerify: false,
		})
	).value;
	if (sim.err) {
		console.log('simulation:', sim.logs);
		throw new Error(JSON.stringify(sim.err));
	}

	try {
		const sig = await provider.connection.sendTransaction(tx, {
			skipPreflight: true,
		});
		const confirm = await provider.connection.confirmTransaction(sig);
		if (confirm.value.err) {
			throw new Error(JSON.stringify(confirm.value.err));
		}
		return sig;
	} catch (e: any) {
		throw new Error(e);
	}
}

export async function createUsdcAssociatedTokenAccount(
	usdcMint: PublicKey,
	provider: Provider,
	owner: PublicKey
): Promise<PublicKey> {
	// @ts-ignore
	const funderSigner = walletToAsyncSigner(provider.wallet);

	const ixs: InstructionReturn[] = [];

	const usdcAta = getAssociatedTokenAddressSync(usdcMint, owner, true);
	const userAtaExists = await provider.connection.getAccountInfo(usdcAta);
	if (userAtaExists === null) {
		const createAtaIx: InstructionReturn = () => {
			return Promise.resolve({
				instruction: createAssociatedTokenAccountInstruction(
					funderSigner.publicKey(),
					usdcAta,
					owner,
					usdcMint
				),
				signers: [funderSigner],
			});
		};
		ixs.push(createAtaIx);
	}

	const res = await sendTransactionWithResult(
		ixs,
		funderSigner,
		provider.connection
	);
	if (res.isErr()) {
		throw new Error(
			`Error creating USDC ATA: ${JSON.stringify(res.error as TransactionError)}`
		);
	}
	return usdcAta;
}

export async function bootstrapDevnetInvestor(params: {
	payer: AnchorProvider;
	programId: PublicKey;
	usdcMint: PublicKey;
	signer: Keypair;
	driftClientConfig: Omit<DriftClientConfig, 'connection' | 'wallet'>;
	depositCollateral?: boolean;
	vaultClientCliMode?: boolean;
}): Promise<{
	signer: Keypair;
	usdcAta: PublicKey;
	user: User;
	driftClient: DriftClient;
	vaultClient: VaultClient;
	provider: AnchorProvider;
}> {
	const {
		payer,
		programId,
		usdcMint,
		vaultClientCliMode,
		driftClientConfig,
		signer,
		depositCollateral,
	} = params;
	const {
		accountSubscription,
		opts,
		activeSubAccountId,
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
	} = driftClientConfig;

	const balance =
		(await payer.connection.getBalance(signer.publicKey)) / LAMPORTS_PER_SOL;
	if (balance < 0.01) {
		throw new Error(
			`Signer (${signer.publicKey.toString()}) has less than 0.01 devnet SOL (${balance}), get more here: https://faucet.solana.com/`
		);
	}

	const driftClient = new DriftClient({
		connection: payer.connection,
		wallet: new Wallet(signer),
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId,
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
		accountSubscription,
	});
	await driftClient.subscribe();
	const provider = new anchor.AnchorProvider(
		payer.connection,
		new anchor.Wallet(signer),
		opts ?? {
			commitment: 'confirmed',
		}
	);
	const program = new Program(IDL, programId, provider);
	const vaultClient = new VaultClient({
		// @ts-ignore
		driftClient,
		program,
		cliMode: vaultClientCliMode ?? true,
	});
	const usdcAta = await createUsdcAssociatedTokenAccount(
		usdcMint,
		payer,
		signer.publicKey
	);

	const userKey = await getUserAccountPublicKey(
		driftClient.program.programId,
		signer.publicKey,
		0
	);
	const userAcct = await provider.connection.getAccountInfo(userKey);

	let deposit = depositCollateral ?? false;
	const solReserve = 0.25;
	const availableSol =
		(await provider.connection.getBalance(signer.publicKey)) / LAMPORTS_PER_SOL;
	const sol = Math.max(availableSol - solReserve, 0);
	if (sol < solReserve && depositCollateral) {
		console.warn(
			`Need more than 0.25 SOL to enable a Drift deposit, investor has ${availableSol}, skipping deposit.`
		);
		deposit = false;
	}

	console.log(
		`${sol} SOL available to deposit with 0.25 reserved for rent and fees`
	);
	const solSpotMarket = driftClient
		.getSpotMarketAccounts()
		.find((m) => m.mint.equals(WRAPPED_SOL_MINT));
	if (!solSpotMarket) {
		throw new Error('SOL spot market not found');
	}
	const amount = driftClient.convertToSpotPrecision(
		solSpotMarket.marketIndex,
		sol
	);

	if (!userAcct && deposit) {
		const [sig, _] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				amount,
				// if depositing native SOL this is the wallet public key, not an associated token account
				signer.publicKey,
				solSpotMarket.marketIndex,
				activeSubAccountId
			);
		console.log(
			'init user and deposit SOL:',
			signatureLink(sig, provider.connection)
		);
	} else if (userAcct && deposit) {
		const [sig, _] = await driftClient.deposit(
			amount,
			solSpotMarket.marketIndex,
			// if depositing native SOL this is the wallet public key, not an associated token account
			signer.publicKey,
			activeSubAccountId
		);
		console.log('deposited SOL:', signatureLink(sig, provider.connection));
	} else if (!userAcct && !deposit) {
		const [sig, _] =
			await driftClient.initializeUserAccount(activeSubAccountId);
		console.log('init user:', signatureLink(sig, provider.connection));
	}

	const user = new User({
		driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
	});
	await user.subscribe();

	return {
		signer,
		usdcAta,
		user,
		driftClient,
		vaultClient,
		provider,
	};
}
