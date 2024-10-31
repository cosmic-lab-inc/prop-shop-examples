import * as anchor from '@coral-xyz/anchor';
import {Program} from '@coral-xyz/anchor';
import {
  AdminClient,
  BN,
  decodeName,
  DriftClient,
  getLimitOrderParams,
  getUserStatsAccountPublicKey,
  PositionDirection,
  PostOnlyParams,
  PublicKey,
  QUOTE_PRECISION,
  TakerInfo,
  User,
  UserAccount,
  WRAPPED_SOL_MINT,
} from '@drift-labs/sdk';
import {ConfirmOptions, LAMPORTS_PER_SOL, Signer, Transaction, TransactionInstruction,} from '@solana/web3.js';
import {DRIFT_VAULTS_PROGRAM_ID, getTokenBalance, signatureLink, TEST_DRIFT_INVESTOR, TEST_MANAGER, Venue,} from '@cosmic-lab/prop-shop-sdk';
import {DriftMomentumBot, StandardTimeframe,} from '@cosmic-lab/prop-shop-examples';
import {assert} from 'chai';
import {DriftVaults, getVaultDepositorAddressSync, getVaultProtocolAddressSync, IDL as DRIFT_VAULTS_IDL, VaultClient,} from '@drift-labs/vaults-sdk';
import {bootstrapDevnetInvestor, sendTx} from './driftHelpers';
import {createCloseAccountInstruction} from '@solana/spl-token';
import {MarketInfo} from '@cosmic-lab/prop-shop-examples/src/types';

describe('phoenixMomentumBot', () => {
  const opts: ConfirmOptions = {
    preflightCommitment: 'confirmed',
    skipPreflight: false,
    commitment: 'confirmed',
  };

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const program = new Program(
    DRIFT_VAULTS_IDL as any as anchor.Idl,
    DRIFT_VAULTS_PROGRAM_ID,
    provider
  ) as any as Program<DriftVaults>;

  let admin: AdminClient;
  const manager = TEST_MANAGER;
  console.log('manager:', manager.publicKey.toString());
  const fundName = `DriftMomentumBot`;
  let bot: DriftMomentumBot;

  const investor = TEST_DRIFT_INVESTOR;
  console.log('investor:', investor.publicKey.toString());
  let investorClient: VaultClient;
  let investorUser: User;
  let investorUsdcAta: PublicKey;

  let usdcMint: PublicKey;

  before(async () => {
    const genesisHash = await connection.getGenesisHash();
    const devnetGenesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    if (genesisHash !== devnetGenesisHash) {
      throw new Error(
        'This test is only for devnet, please change your ANCHOR_PROVIDER_URL env to be a devnet RPC endpoint'
      );
    }

    const managerSol =
      (await connection.getBalance(manager.publicKey)) / LAMPORTS_PER_SOL;
    console.log('manager SOL:', managerSol);
    const investorSol =
      (await connection.getBalance(investor.publicKey)) / LAMPORTS_PER_SOL;
    console.log('investor SOL:', investorSol);

    admin = new AdminClient({
      connection,
      wallet: provider.wallet,
      opts: {
        commitment: 'confirmed',
      },
      activeSubAccountId: 0,
      accountSubscription: {
        type: 'websocket',
        resubTimeoutMs: 30_000,
      },
    });
    await admin.subscribe();

    const solPerpMarket = admin
      .getPerpMarketAccounts()
      .find((m) => decodeName(m.name) === 'SOL-PERP');
    if (!solPerpMarket) {
      throw new Error('SOL perp market not found');
    }
    const market = MarketInfo.perp(solPerpMarket.marketIndex);
    bot = await DriftMomentumBot.fromKeypair({
      connection,
      keypair: manager,
      fundName,
      market,
      simulate: true,
      tf: StandardTimeframe.FIVE_SECONDS,
    });

    const mintInfoResult = await bot.usdcMintInfo();
    if (mintInfoResult.isErr()) {
      throw mintInfoResult.error;
    }
    usdcMint = mintInfoResult.value.mint;

    const marketAcct = bot.driftClient.getPerpMarketAccount(0);
    if (!marketAcct) {
      throw new Error('Perp market not found');
    }

    // the VaultDepositor for the vault
    const bootstrapInvestor = await bootstrapDevnetInvestor({
      signer: investor,
      payer: provider,
      programId: program.programId,
      depositCollateral: true,
      usdcMint,
      driftClientConfig: {
        accountSubscription: {
          type: 'websocket',
          resubTimeoutMs: 30_000,
        },
        opts,
        activeSubAccountId: 0,
      },
    });
    investorClient = bootstrapInvestor.vaultClient;
    investorUser = bootstrapInvestor.user;
    investorUsdcAta = bootstrapInvestor.usdcAta;
  });

  after(async () => {
    await investorClient.driftClient.unsubscribe();
    await admin.unsubscribe();
    await bot.shutdown();
  });

  it('Create Fund', async () => {
    if (bot.fund !== undefined) {
      return;
    }
    const snack = await bot.createFund({
      name: fundName,
      venue: Venue.Drift,
      percentProfitShare: 20,
      percentAnnualManagementFee: 2,
    });
    await bot.fetchFund();
    assert(snack.variant === 'success');
    assert(bot.fund !== undefined);
  });

  // assign "delegate" to trade on behalf of the vault
  it('Update Fund Delegate', async () => {
    await bot.fetchFund();
    const fundAcct = await program.account.vault.fetch(bot.fundKey);
    await bot.program.methods
      .updateDelegate(bot.key)
      .accounts({
        vault: bot.fundKey,
        driftUser: fundAcct.user,
        driftProgram: admin.program.programId,
      })
      .rpc();
    const user = (await admin.program.account.user.fetch(
      fundAcct.user
    )) as UserAccount;
    assert(user.delegate.equals(bot.key));
  });

  it('Initialize Investor', async () => {
    const investorKey = getVaultDepositorAddressSync(
      program.programId,
      bot.fundKey,
      investor.publicKey
    );
    const investorAcct = await connection.getAccountInfo(investorKey);
    if (investorAcct !== null) {
      console.warn(
        `Investor account (${investorKey.toString()}) exists, skipping initialization.`
      );
      return;
    }
    await investorClient.initializeVaultDepositor(
      bot.fundKey,
      investor.publicKey
    );
    const vaultDepositor = getVaultDepositorAddressSync(
      program.programId,
      bot.fundKey,
      investor.publicKey
    );
    const investorAcctAfter =
      await program.account.vaultDepositor.fetch(vaultDepositor);
    assert(investorAcctAfter.vault.equals(bot.fundKey));
  });

  /**
   * START Workaround
   * The following 3 tests are NOT needed for a localnet or mainnet, but are needed for a devnet.
   * On localnet, USDC is a mint the test suite creates and can therefore be minted to the investor wallet.
   * On mainnet, USDC can be easily acquired by swapping anything for it on any CEX/DEX.
   * On devnet, the USDC faucet from Circle doesn't work, but the Solana SOL faucet does.
   * Since no exchange hosts a devnet UI, we have to swap SOL into USDC via code.
   * The following tests direct the investor to get SOL from the faucet if needed.
   * Make sure you paste the investor address as the recipient (the test logs will tell you the address)!
   * Then the following tests deposit the SOL onto the devnet Drift SOL/USDC market,
   * swap for USDC, then withdraw back to the investor wallet.
   * The test suite then continues as it would on localnet or mainnet
   * -- the investor deposits USDC into the fund and the fund can trade with it.
   */

  it('Cancel Open Orders', async () => {
    const ixs: TransactionInstruction[] = [];
    const markets = investorClient.driftClient.getSpotMarketAccounts();
    for (const order of investorUser.getOpenOrders()) {
      const market = markets.find((m) => m.marketIndex === order.marketIndex);
      if (!market) {
        throw new Error(`Market ${order.marketIndex} not found`);
      }
      const base =
        order.baseAssetAmount.toNumber() / Math.pow(10, market.decimals);
      const name = decodeName(market.name);
      console.log(
        `${name} [${order.marketIndex}] open order before cancel: ${base}`
      );
      ixs.push(
        await investorClient.driftClient.getCancelOrderIx(order.orderId)
      );
    }

    if (ixs.length > 0) {
      const cancelOrdersTx = (await investorClient.driftClient.buildTransaction(
        ixs
      )) as Transaction;
      cancelOrdersTx.sign(
        ...[
          {
            publicKey: investor.publicKey,
            secretKey: investor.secretKey,
          } as any as Signer,
        ]
      );
      const cancelOrdersSim =
        await connection.simulateTransaction(cancelOrdersTx);
      console.log(cancelOrdersSim.value.logs);
      const cancelOrderSig = await sendTx(provider, ixs, [
        {
          publicKey: investor.publicKey,
          secretKey: investor.secretKey,
        } as any as Signer,
      ]);
      console.log(
        'cancel orders sig:',
        signatureLink(cancelOrderSig, connection)
      );
    }
    await investorUser.fetchAccounts();
    assert(!investorUser.getUserAccount().hasOpenOrder);
    console.log('cancelled all open orders');
  });

  it('Investor Sell SOL for USDC', async () => {
    const tvl = bot.fund?.tvl ?? 0;
    if (tvl > 100) {
      console.warn(
        `Fund has sufficient USDC ($${tvl}), skipping converting investor SOL to USDC to deposit into fund`
      );
      return;
    }

    // devnet USDC faucet is not working, but SOL faucet does,
    // so we deposited SOL as collateral onto Drift SOL/USDC market in the "before" hook.
    // Now we'll swap that SOL for USDC, then we can (finally) deposit into the fund
    const solSpotMarket = investorClient.driftClient
      .getSpotMarketAccounts()
      .find((m) => m.mint.equals(WRAPPED_SOL_MINT));
    if (!solSpotMarket) {
      throw new Error('SOL spot market not found');
    }

    {
      const pos = investorUser.getSpotPosition(solSpotMarket.marketIndex);
      if (!pos) {
        throw new Error('Position not found');
      }
      const base =
        pos.scaledBalance.toNumber() / Math.pow(10, solSpotMarket.decimals);
      const name = decodeName(solSpotMarket.name);
      console.log(`${name} [${pos.marketIndex}] position:`, base);
    }

    const {
      price,
      size: takerSize,
      maker: taker,
      orderId: takerOrderId,
    } = bot.marketBidAsk(MarketInfo.spot(solSpotMarket.marketIndex)).bid;
    console.log(`Best bid price: $${price}`);

    console.log(
      'Investor user:',
      investorUser.getUserAccountPublicKey().toString()
    );
    const freeUsdcCollateral = investorUser
      .getSpotMarketAssetValue(solSpotMarket.marketIndex, 'Initial', true, true)
      .div(QUOTE_PRECISION)
      .toNumber();
    const availableSolToSell = freeUsdcCollateral / price;
    console.log(
      `Investor SOL equity, $${freeUsdcCollateral} (~${availableSolToSell.toFixed(2)} SOL)`
    );

    const takerUserAccount =
      (await investorClient.driftClient.program.account.user.fetch(
        taker
      )) as UserAccount;
    const takerUser = new User({
      driftClient: investorClient.driftClient,
      userAccountPublicKey: taker,
    });
    await takerUser.subscribe();

    {
      const pos = takerUser.getSpotPosition(solSpotMarket.marketIndex);
      if (!pos) {
        throw new Error('Position not found');
      }
      const name = decodeName(solSpotMarket.name);
      const base = pos.scaledBalance
        .div(new BN(Math.pow(10, solSpotMarket.decimals)))
        .toNumber();
      const bids =
        pos.openBids.toNumber() / Math.pow(10, solSpotMarket.decimals);
      const asks =
        pos.openAsks.toNumber() / Math.pow(10, solSpotMarket.decimals);
      const deposits =
        pos.cumulativeDeposits.toNumber() /
        Math.pow(10, solSpotMarket.decimals);
      console.log(
        `${name} [${pos.marketIndex}] taker position:`,
        base,
        'bids:',
        bids,
        'asks:',
        asks,
        'deposits:',
        deposits
      );
    }

    {
      const order = takerUser.getOrder(takerOrderId);
      if (!order) {
        throw new Error('Order not found');
      }
      const name = decodeName(solSpotMarket.name);
      const base =
        order.baseAssetAmount.toNumber() / Math.pow(10, solSpotMarket.decimals);
      console.log(
        `${name} [${order.marketIndex}] taker order: ${base}, post only: ${order.postOnly}, reduce only: ${order.reduceOnly}`
      );
    }

    const takerStats = getUserStatsAccountPublicKey(
      investorClient.driftClient.program.programId,
      takerUserAccount.authority
    );
    const takerOrder = takerUserAccount.orders.find(
      (o) => o.orderId === takerOrderId
    );
    if (!takerOrder) {
      throw new Error(`Taker order ${takerOrderId} not found`);
    }
    const takerInfo: TakerInfo = {
      taker,
      takerStats,
      takerUserAccount,
      order: takerOrder,
    };

    const solToSell = Math.min(availableSolToSell, takerSize);
    if (takerSize < availableSolToSell) {
      console.warn(
        `Taker has ${takerSize} SOL to match investor's ${solToSell} SOL`
      );
    }

    const minOrderSize =
      solSpotMarket.orderStepSize.toNumber() /
      Math.pow(10, solSpotMarket.decimals);
    if (solToSell < minOrderSize) {
      console.warn(
        `Order size ${solToSell} is less than the order step size ${minOrderSize}, skipping order.`
      );
    } else {
      const orderParams = getLimitOrderParams({
        marketIndex: solSpotMarket.marketIndex,
        direction: PositionDirection.SHORT,
        baseAssetAmount: investorClient.driftClient.convertToSpotPrecision(
          solSpotMarket.marketIndex,
          solToSell
        ),
        price: investorClient.driftClient.convertToPricePrecision(price),
        reduceOnly: true,
        userOrderId: 1,
        postOnly: PostOnlyParams.MUST_POST_ONLY,
        immediateOrCancel: true,
      });

      const simTx = (await investorClient.driftClient.buildTransaction(
        await investorClient.driftClient.getPlaceAndMakeSpotOrderIx(
          orderParams,
          takerInfo
        )
      )) as Transaction;
      simTx.sign(
        ...[
          {
            publicKey: investor.publicKey,
            secretKey: investor.secretKey,
          } as any as Signer,
        ]
      );
      const sim = await connection.simulateTransaction(simTx);
      console.log('sell simulation:', sim.value.logs);

      const sig = await investorClient.driftClient.placeAndMakeSpotOrder(
        orderParams,
        takerInfo
      );
      console.log('investor sell sig:', signatureLink(sig, connection));
    }

    // now that devnet SOL has been swapped for USDC, we need to withdraw back to the wallet,
    // so it can then be deposited into the fund
    await investorUser.fetchAccounts();
    const openOrder = investorUser
      .getOpenOrders()
      .find((o) => o.marketIndex === solSpotMarket.marketIndex);
    if (!openOrder) {
      console.log('Place and make filled!');
    } else {
      const base =
        openOrder.baseAssetAmount.toNumber() /
        Math.pow(10, solSpotMarket.decimals);
      const name = decodeName(solSpotMarket.name);
      console.log(`${name} open order:`, base);
    }
  });

  it('Investor Withdraw USDC', async () => {
    const tvl = bot.fund?.tvl ?? 0;
    if (tvl > 100) {
      return;
    }

    const solSpotMarket = investorClient.driftClient
      .getSpotMarketAccounts()
      .find((m) => m.mint.equals(WRAPPED_SOL_MINT));
    if (!solSpotMarket) {
      throw new Error('SOL spot market not found');
    }

    {
      const pos = investorUser.getSpotPosition(solSpotMarket.marketIndex);
      if (!pos) {
        throw new Error('Position not found');
      }
      const base =
        pos.scaledBalance.toNumber() / Math.pow(10, solSpotMarket.decimals);
      const name = decodeName(solSpotMarket.name);
      console.log(`${name} [${pos.marketIndex}] position:`, base);
    }
    {
      const order = investorUser
        .getOpenOrders()
        .find((o) => o.marketIndex === solSpotMarket.marketIndex);
      if (order) {
        const base =
          order.baseAssetAmount.toNumber() /
          Math.pow(10, solSpotMarket.decimals);
        const name = decodeName(solSpotMarket.name);
        console.warn(`${name} order still open:`, base);
      }
    }

    const usdcToWithdraw =
      investorUser.getSpotMarketAssetValue(0, 'Initial').toNumber() /
      QUOTE_PRECISION.toNumber();
    console.log(`usdc available to withdraw: $${usdcToWithdraw}`);

    // withdraw
    const withdrawIxs = await getWithdrawalIxs(
      investorClient.driftClient,
      investorClient.driftClient.convertToSpotPrecision(0, usdcToWithdraw),
      0,
      investorUsdcAta
    );
    const tx = (await investorClient.driftClient.buildTransaction(
      withdrawIxs
    )) as Transaction;
    tx.sign(
      ...[
        {
          publicKey: investor.publicKey,
          secretKey: investor.secretKey,
        } as any as Signer,
      ]
    );
    const sim = await connection.simulateTransaction(tx);
    console.log(sim.value.logs);
    await investorClient.driftClient.withdraw(
      investorClient.driftClient.convertToSpotPrecision(0, usdcToWithdraw),
      0,
      investorUsdcAta,
      true
    );

    const investorUsdcInWallet = await getTokenBalance(
      connection,
      investorUsdcAta
    );
    console.log(`investor usdc in wallet: $${investorUsdcInWallet}`);
  });

  /**
   * END Workaround
   */

  it('Investor Deposit', async () => {
    const tvl = bot.fund?.tvl ?? 0;
    if (tvl > 100) {
      return;
    }

    const vaultAccount = await program.account.vault.fetch(bot.fundKey);
    const vaultDepositor = getVaultDepositorAddressSync(
      program.programId,
      bot.fundKey,
      investor.publicKey
    );
    const remainingAccounts = investorClient.driftClient.getRemainingAccounts({
      userAccounts: [],
      writableSpotMarketIndexes: [0],
    });
    if (vaultAccount.vaultProtocol) {
      const vaultProtocol = getVaultProtocolAddressSync(
        bot.program.programId,
        bot.fundKey
      );
      remainingAccounts.push({
        pubkey: vaultProtocol,
        isSigner: false,
        isWritable: true,
      });
    }

    const driftSpotMarketVault = bot.driftClient.getSpotMarketAccount(0)?.vault;
    if (!driftSpotMarketVault) {
      throw new Error('Spot market not found');
    }
    const usdcToDeposit = await getTokenBalance(connection, investorUsdcAta);
    console.log(`investor usdc: $${usdcToDeposit}`);
    if (usdcToDeposit < 1) {
      console.warn('Investor has <$1, skipping deposit');
      return;
    }

    const usdcToDepositBN = new BN(usdcToDeposit).mul(QUOTE_PRECISION);
    await investorClient.program.methods
      .deposit(usdcToDepositBN)
      .accounts({
        vault: bot.fundKey,
        vaultDepositor,
        vaultTokenAccount: vaultAccount.tokenAccount,
        driftUserStats: vaultAccount.userStats,
        driftUser: vaultAccount.user,
        driftState: await admin.getStatePublicKey(),
        userTokenAccount: investorUsdcAta,
        driftSpotMarketVault,
        driftProgram: admin.program.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    const investorAcct =
      await program.account.vaultDepositor.fetch(vaultDepositor);
    assert(investorAcct.vault.equals(bot.fundKey));
    // assert(investorAcct.netDeposits.eq(usdcToDepositBN));
    console.log('fund TVL in USDC:', (await bot.fetchFund())?.tvl ?? 0);

    const investorUserAcct = investorClient.driftClient.getUserAccount(
      0,
      investor.publicKey
    );
    assert(investorUserAcct !== undefined);
  });

  it(
    'Fund Long SOL-PERP',
    async () => {
      await bot.start();
    },
    60_000 * 10
  );
});

async function getWithdrawalIxs(
  driftClient: DriftClient,
  amount: BN,
  marketIndex: number,
  associatedTokenAddress: PublicKey,
  reduceOnly = false,
  subAccountId?: number
) {
  const withdrawIxs: anchor.web3.TransactionInstruction[] = [];

  const spotMarketAccount = driftClient.getSpotMarketAccount(marketIndex);
  if (!spotMarketAccount) {
    throw new Error(`Spot market ${marketIndex} not found`);
  }

  const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

  const authority = driftClient.wallet.publicKey;

  const createWSOLTokenAccount =
    isSolMarket && associatedTokenAddress.equals(authority);

  if (createWSOLTokenAccount) {
    const {ixs, pubkey} = await driftClient.getWrappedSolAccountCreationIxs(
      amount,
      false
    );

    associatedTokenAddress = pubkey;

    withdrawIxs.push(...ixs);
  } else {
    const accountExists = await checkIfAccountExists(
      driftClient,
      associatedTokenAddress
    );

    if (!accountExists) {
      const createAssociatedTokenAccountIx =
        driftClient.getAssociatedTokenAccountCreationIx(
          spotMarketAccount.mint,
          associatedTokenAddress,
          driftClient.getTokenProgramForSpotMarket(spotMarketAccount)
        );

      withdrawIxs.push(createAssociatedTokenAccountIx);
    }
  }

  const withdrawCollateralIx = await driftClient.getWithdrawIx(
    amount,
    spotMarketAccount.marketIndex,
    associatedTokenAddress,
    reduceOnly,
    subAccountId
  );

  withdrawIxs.push(withdrawCollateralIx);

  // Close the wrapped sol account at the end of the transaction
  if (createWSOLTokenAccount) {
    withdrawIxs.push(
      createCloseAccountInstruction(
        associatedTokenAddress,
        authority,
        authority,
        []
      )
    );
  }

  return withdrawIxs;
}

async function checkIfAccountExists(
  driftClient: DriftClient,
  account: PublicKey
): Promise<boolean> {
  try {
    const accountInfo = await driftClient.connection.getAccountInfo(account);
    return accountInfo != null;
  } catch (e) {
    // Doesn't already exist
    return false;
  }
}
