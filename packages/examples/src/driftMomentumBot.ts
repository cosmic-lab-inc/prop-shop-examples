import {Commitment, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction,} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {CreateVaultConfig, DriftVaultsClient, FundOverview, signatureLink, sleep, SnackInfo, UiL3BidAsk,} from '@cosmic-lab/prop-shop-sdk';
import {AsyncSigner, keypairToAsyncSigner, walletAdapterToAsyncSigner,} from '@cosmic-lab/data-source';
import {DriftVaults, getVaultAddressSync, Vault,} from '@drift-labs/vaults-sdk';
import {
  BASE_PRECISION,
  BN,
  decodeName,
  DepositRecord,
  DLOBSubscriber,
  DriftClient,
  encodeName,
  EventSubscriber,
  getMarketOrderParams,
  isVariant,
  MarketType,
  OrderActionRecord,
  OrderSubscriber,
  PositionDirection,
  PRICE_PRECISION,
  QUOTE_PRECISION,
  User,
} from '@drift-labs/sdk';
import * as splToken from '@solana/spl-token';
import {WalletContextState} from '@solana/wallet-adapter-react';
import {err, ok, Result} from 'neverthrow';
import {EventSubscriptionOptions} from '@drift-labs/sdk/src/events/types';
import {MarketInfo, MarketPriceInfo, RingBuffer, StandardTimeframe, Timeframe,} from './types';

/**
 * In this example, this is a bot that automatically trades based on a simple signal-based strategy.
 * The strategy is a "momentum" strategy that buys if price is >X period moving average, and sells if below.
 * For most blue-chip tokens this strategy backtests well, as that which is trending tends to continue trending (momentum).
 *
 * If you are forking this example bot, then change the trading strategy logic within the "assessTrade" function.
 * All other code should be reusable as is.
 *
 * Upon calling "initialize" the bot will stream deposit/withdraw/order events,
 * as well as the orderbook if you need that instead of the oracle price in order to make trading decisions.
 *
 * The functions to place trades are already implemented for you (placeMarketPerpOrder, etc.).
 * The getters to read the fund state and relevant keys are also implemented for you.
 *
 * For in depth usage see "tests/exampleDevnetBot.ts"
 * ```
 * const bot = await DriftMomentumBot.fromKeypair(connection, keypair, 'fundName');
 * await bot.start(); // or manually call functions if used for other purposes
 * ```
 */
export class DriftMomentumBot {
  private readonly conn: Connection;
  // AsyncSigner is a unified interface that a wallet (UI) or keypair (bot) can implement.
  // It prevents the need for conditional logic to handle a wallet or keypair.
  private signer: AsyncSigner;
  key: PublicKey;
  private client: DriftVaultsClient;
  readonly fundName: string;
  private _eventSubscriber: EventSubscriber | undefined;
  private _orderSubscriber: OrderSubscriber | undefined;
  private _dlobSubscriber: DLOBSubscriber | undefined;
  private running = false;
  private market: MarketInfo;
  private marketCache: RingBuffer<MarketPriceInfo>;
  private timeframe: Timeframe;
  private readonly simulate: boolean;

  /**
   * Create a new DriftMomentumBot from a keypair (bot) and initialize in one step
   * @param params
   * @param connection - Solana RPC connection
   * @param keypair - Transaction payer and authority of the Prop Shop fund
   * @param fundName - Name of the Prop Shop fund to manage
   * @param market - market index and spot/perp type
   * @param marketCacheSize - Number of market prices to cache
   * @param tf - Timeframe to use for trading
   * @param simulate - Simulate transaction instead of sending
   * @returns DriftMomentumBot
   */
  static async fromKeypair(params: {
    connection: Connection;
    keypair: Keypair;
    fundName: string;
    market: MarketInfo;
    marketCacheSize?: number;
    tf?: StandardTimeframe;
    simulate?: boolean;
  }): Promise<DriftMomentumBot> {
    const {keypair, ...rest} = params;
    const self = new DriftMomentumBot({
      signer: keypairToAsyncSigner(keypair),
      ...rest,
    });
    await self.initialize();
    return self;
  }

  /**
   * Create a new DriftMomentumBot from a wallet (UI) and initialize in one step
   * @param params
   * @param connection - Solana RPC connection
   * @param wallet - Transaction payer and authority of the Prop Shop fund
   * @param fundName - Name of the Prop Shop fund to manage
   * @param market - market index and spot/perp type
   * @param marketCacheSize - Number of market prices to cache
   * @param tf - Timeframe to use for trading
   * @param simulate - Simulate transaction instead of sending
   */
  static async fromWallet(params: {
    connection: Connection;
    wallet: WalletContextState;
    fundName: string;
    market: MarketInfo;
    marketCacheSize?: number;
    tf?: StandardTimeframe;
    simulate?: boolean;
  }): Promise<DriftMomentumBot> {
    const {wallet, ...rest} = params;
    const self = new DriftMomentumBot({
      signer: walletAdapterToAsyncSigner(wallet),
      ...rest,
    });
    await self.initialize();
    return self;
  }

  /**
   * @param params
   * @param config - Contains RPC connection and wallet or keypair signer
   * @param fundName - Name of the Prop Shop fund the signer manages (can be new or existing)
   * @param market - market index and spot/perp type
   * @param marketCacheSize - Number of market prices to cache
   * @param tf - Timeframe to use for trading
   * @param simulate - Simulate transaction instead of sending
   */
  constructor(params: {
    signer: AsyncSigner;
    connection: Connection;
    fundName: string;
    market: MarketInfo;
    marketCacheSize?: number;
    tf?: StandardTimeframe;
    simulate?: boolean;
  }) {
    this.conn = params.connection;
    this.signer = params.signer;
    this.key = params.signer.publicKey();
    this.fundName = params.fundName;
    this.client = new DriftVaultsClient({
      signer: params.signer,
      connection: params.connection,
    });
    this.market = params.market;
    this.marketCache = new RingBuffer<MarketPriceInfo>(
      params.marketCacheSize ?? 3
    );
    this.timeframe = new Timeframe(
      params.tf ?? StandardTimeframe.THIRTY_MINUTES
    );
    this.simulate = params.simulate ?? false;
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
    await this.switchToFundUser();

    //
    // event subscriber
    //
    const options: EventSubscriptionOptions = {
      eventTypes: ['DepositRecord', 'OrderRecord', 'OrderActionRecord'],
      maxTx: 4096,
      maxEventsPerType: 4096,
      orderBy: 'blockchain',
      orderDir: 'asc',
      commitment: 'confirmed',
      logProviderConfig: {
        type: 'websocket',
      },
    };
    this._eventSubscriber = new EventSubscriber(
      this.conn,
      this.driftProgram,
      options
    );
    await this.eventSubscriber.subscribe();
    this.eventSubscriber.eventEmitter.on('newEvent', (event) => {
      if (event.eventType === 'OrderActionRecord') {
        const _event = event as OrderActionRecord;
        if (!isVariant(_event.action, 'fill')) {
          if (!isVariant(_event.marketType, 'spot')) {
            const sm = this.driftClient.getSpotMarketAccount(
              _event.marketIndex
            );
            if (!sm) {
              return;
            }
            const info = {
              baseFilled: (_event.baseAssetAmountFilled ?? new BN(0))
                .div(new BN(Math.pow(10, sm.decimals)))
                .toNumber(),
              quoteFilled: (_event.quoteAssetAmountFilled ?? new BN(0))
                .div(new BN(Math.pow(10, sm.decimals)))
                .toNumber(),
              marketIndex: _event.marketIndex,
              price: _event.oraclePrice.toNumber() / PRICE_PRECISION.toNumber(),
            };
            console.log('FILL:', info);
          }
        }
      }

      if (event.eventType === 'DepositRecord') {
        const _event = event as DepositRecord;
        const sm = this.driftClient.getSpotMarketAccount(_event.marketIndex);
        if (!sm) {
          return;
        }
        const info = {
          direction: _event.direction,
          marketIndex: _event.marketIndex,
          amount: _event.amount.toNumber(),
          marketDepositBalance: _event.marketDepositBalance
            .div(new BN(Math.pow(10, sm.decimals)))
            .toNumber(),
          marketWithdrawBalance: _event.marketWithdrawBalance
            .div(new BN(Math.pow(10, sm.decimals)))
            .toNumber(),
          price: _event.oraclePrice.toNumber() / PRICE_PRECISION.toNumber(),
        };
        console.log('WITHDRAW:', info);
      }
    });

    //
    // orderbook subscriber
    //
    const subscriptionConfig:
      | {
      type: 'polling';
      frequency: number;
      commitment?: Commitment;
    }
      | {
      type: 'websocket';
      skipInitialLoad?: boolean;
      resubTimeoutMs?: number;
      logResubMessages?: boolean;
      resyncIntervalMs?: number;
      commitment?: Commitment;
    } = {
      type: 'websocket',
      commitment: 'confirmed',
      resyncIntervalMs: 30_000,
    };
    this._orderSubscriber = new OrderSubscriber({
      driftClient: this.driftClient,
      subscriptionConfig,
    });
    await this.orderSubscriber.subscribe();
    this._dlobSubscriber = new DLOBSubscriber({
      driftClient: this.driftClient,
      dlobSource: this.orderSubscriber, // or UserMap
      slotSource: this.orderSubscriber, // or UserMap
      updateFrequency: 1000,
    });
    await this.dlobSubscriber.subscribe();
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
    await this.eventSubscriber.unsubscribe();
    await this.orderSubscriber.unsubscribe();
    await this.dlobSubscriber.unsubscribe();
  }

  /**
   * In this example, this is a bot that automatically trades based on a strategy.
   * This loop will read the current price for a market and place a market order if the conditions are met.
   * It then monitors the active order and handle fills as needed.
   * If you are forking this example bot, you would change the trading strategy login within this function.
   * By default, the bot will trade with 100% of fund assets every timeframe (i.e. 15 minutes).
   *
   * The strategy is a "momentum" strategy that uses an RSI with a period of 2.
   * If the RSI is >70 it buys, and if it is >90 it sells.
   * It capitalizes on the fact that what is trending tends to continue trending,
   * so even though the RSI is overbought it tends to continue to rise until it is near 90+.
   */
  async start(): Promise<void> {
    this.running = true;
    const rsiBuyThreshold = 70;
    const rsiSellThreshold = 90;
    const marketAcct = this.driftClient.getPerpMarketAccount(
      this.market.marketIndex
    );
    if (!marketAcct) {
      console.error('Perp market not found');
      this.running = false;
      return;
    }
    const marketName = decodeName(marketAcct.name);
    while (this.running) {
      if (!this.market.isPerp()) {
        console.error('Bot only supports perpetual markets');
        this.running = false;
        return;
      }

      const {bid, ask} = this.marketBidAsk();
      const oracle = this.oraclePrice();
      this.marketCache.push({
        bid: {
          price: bid.price,
          size: bid.size,
        },
        ask: {
          price: ask.price,
          size: ask.size,
        },
        oracle,
      });
      console.log(`
        💡Market update, 
        oracle: $${oracle.toFixed(2)}, 
        bid: $${bid.price.toFixed(2)}, 
        ask: $${ask.price.toFixed(2)}
      `);

      // RSI with period of 2
      const rsiResult = this.calculateRSI(2);
      if (rsiResult.isErr()) {
        console.warn(rsiResult.error);
      } else {
        const rsi = rsiResult.value;
        console.log('rsi:', rsi);
        if (rsi > rsiBuyThreshold) {
          console.log(
            `🟢 RSI: ${rsi.toFixed(2)} > ${rsiBuyThreshold}, go long!`
          );
          // long with 100% of USDC
          const quote =
            this.fundUser.getSpotMarketAssetValue(0, 'Initial').toNumber() /
            QUOTE_PRECISION.toNumber();
          const base = quote / ask.price;
          console.log(
            `long ${marketName} with $${quote.toFixed(2)} (~${base.toFixed(2)} base units)`
          );
          const _snack = await this.placeMarketPerpOrder(
            quote,
            PositionDirection.LONG,
            undefined,
            undefined,
            true
          );
        } else if (rsi > rsiSellThreshold) {
          console.log(
            `🔴 RSI: ${rsi.toFixed(2)} > ${rsiSellThreshold}, go short!`
          );
          // short with 100% of SOL
          const quote =
            this.fundUser
              .getSpotMarketAssetValue(this.market.marketIndex, 'Initial')
              .toNumber() / QUOTE_PRECISION.toNumber();
          const base = quote / bid.price;
          console.log(
            `short ${marketName} with $${quote.toFixed(2)} (~${base.toFixed(2)} base units)`
          );

          const _snack = await this.placeMarketPerpOrder(
            quote,
            PositionDirection.SHORT,
            undefined,
            undefined,
            true
          );
        }
      }

      await sleep(1000 * this.timeframe.toUnixSeconds());
    }
  }

  /**
   * Calculate the Relative Strength Index (RSI) for the given period
   * @param period - Number of timeframes to calculate RSI over
   * @returns RSI value
   */
  calculateRSI(period: number): Result<number, string> {
    if (this.marketCache.size() < period) {
      return err('Not enough data to calculate RSI');
    }
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < period; i++) {
      console.log(`[${i}]: ${this.marketCache.get(i).oracle}`);
      console.log(`[${i - 1}]: ${this.marketCache.get(i - 1).oracle}`);
      const diff =
        this.marketCache.get(i).oracle - this.marketCache.get(i - 1).oracle;
      if (diff > 0) {
        gain += diff;
      } else {
        loss -= diff;
      }
    }
    const avgGain = gain / period;
    const avgLoss = loss / period;
    const rs = avgGain / avgLoss;
    console.log('gain:', gain, 'loss:', loss);
    console.log('avgGain:', avgGain, 'avgLoss:', avgLoss);
    console.log('rs:', rs);
    if (isNaN(rs)) {
      return err('RSI calculation resulted in NaN');
    }
    return ok(100 - 100 / (1 + rs));
  }

  async switchToFundUser(): Promise<void> {
    const fund = await this.fetchFund();
    if (fund !== undefined) {
      await this.driftClient.addUser(0, this.fundKey);
      await this.driftClient.switchActiveUser(0, this.fundKey);
      console.log('switched active user');
    }
  }

  get fundUser(): User {
    return this.driftClient.getUser(0, this.fundKey);
  }

  get driftClient(): DriftClient {
    return this.client.driftClient;
  }

  get eventSubscriber(): EventSubscriber {
    if (!this._eventSubscriber) {
      throw new Error('Event subscriber not initialized');
    }
    return this._eventSubscriber;
  }

  get orderSubscriber(): OrderSubscriber {
    if (!this._orderSubscriber) {
      throw new Error('Order subscriber not initialized');
    }
    return this._orderSubscriber;
  }

  get dlobSubscriber(): DLOBSubscriber {
    if (!this._dlobSubscriber) {
      throw new Error('DLOB subscriber not initialized');
    }
    return this._dlobSubscriber;
  }

  get program(): anchor.Program<DriftVaults> {
    return this.client.vaultProgram;
  }

  get driftProgram(): anchor.Program<anchor.Idl> {
    return this.driftClient.program;
  }

  get fundKey(): PublicKey {
    return getVaultAddressSync(
      this.program.programId,
      encodeName(this.fundName)
    );
  }

  get fund(): FundOverview | undefined {
    const funds = this.client.fundOverviews;
    return funds.find((f) => f.title === this.fundName);
  }

  get fundOrErr(): FundOverview {
    const funds = this.client.fundOverviews;
    const fund = funds.find((f) => f.title === this.fundName);
    if (!fund) {
      throw new Error(`Fund ${this.fundName} not found`);
    }
    return fund;
  }

  async fetchFund(): Promise<FundOverview | undefined> {
    await this.client.fetchFundOverviews();
    return this.fund;
  }

  async createFund(config: CreateVaultConfig): Promise<SnackInfo> {
    if (this.fund !== undefined) {
      console.warn(`Fund ${this.fundName} already exists`);
      return {
        variant: 'error',
        message: `Fund ${this.fundName} already exists`,
      };
    }
    const snack = (await this.client.createVault(config)).snack;
    // delegate assumes control of vault user
    await this.switchToFundUser();
    return snack;
  }

  async usdcMintInfo(): Promise<
    Result<
      {
        mint: PublicKey;
        authority: PublicKey;
        decimals: number;
      },
      string
    >
  > {
    const sm = this.driftClient.getSpotMarketAccount(0);
    if (!sm) {
      return err('USDC spot market not found');
    }
    const usdcMint = sm.mint;
    const usdcMintData = await splToken.getMint(this.conn, usdcMint);
    if (usdcMintData.mintAuthority === null) {
      return err('Mint authority not found');
    }
    return ok({
      mint: usdcMint,
      authority: usdcMintData.mintAuthority,
      decimals: usdcMintData.decimals,
    });
  }

  async sendTx(
    ixs: TransactionInstruction[],
    successMessage: string,
    errorMessage: string,
    successCallback?: (...args: any[]) => Promise<void>
  ): Promise<SnackInfo> {
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 10_000,
      }),
      ...ixs,
    ];

    const recentBlockhash = await this.conn
      .getLatestBlockhash()
      .then((res) => res.blockhash);
    const msg = new anchor.web3.TransactionMessage({
      payerKey: this.key,
      recentBlockhash,
      instructions,
    }).compileToV0Message();
    let tx = new anchor.web3.VersionedTransaction(msg);
    tx = await this.signer.sign(tx);

    const sim = (
      await this.conn.simulateTransaction(tx, {
        sigVerify: false,
      })
    ).value;
    if (sim.err) {
      const msg = `${errorMessage}: ${JSON.stringify(sim.err)}}`;
      console.log(sim.logs);
      console.error(msg);
      return {
        variant: 'error',
        message: errorMessage,
      };
    }
    if (this.simulate) {
      return {
        variant: 'success',
        message: successMessage,
      };
    }

    try {
      const sig = await this.conn.sendTransaction(tx, {
        skipPreflight: true,
      });
      console.debug(`${successMessage}: ${signatureLink(sig, this.conn)}`);
      const confirm = await this.conn.confirmTransaction(sig);
      if (confirm.value.err) {
        console.error(`${errorMessage}: ${JSON.stringify(confirm.value.err)}`);
        return {
          variant: 'error',
          message: errorMessage,
        };
      } else {
        if (successCallback) {
          await successCallback();
        }
        return {
          variant: 'success',
          message: successMessage,
        };
      }
    } catch (e: any) {
      return {
        variant: 'error',
        message: errorMessage,
      };
    }
  }

  oraclePrice(market = this.market): number {
    if (market.marketType === MarketType.PERP) {
      const pm = this.driftClient.getPerpMarketAccount(market.marketIndex);
      if (!pm) {
        throw new Error(`Perp market ${market.marketIndex} not found`);
      }
      const oracle = this.driftClient.getOracleDataForPerpMarket(
        pm.marketIndex
      );
      return oracle.price.toNumber() / PRICE_PRECISION.toNumber();
    } else {
      const sm = this.driftClient.getSpotMarketAccount(market.marketIndex);
      if (!sm) {
        throw new Error(`Spot market ${market.marketIndex} not found`);
      }
      const oracle = this.driftClient.getOracleDataForSpotMarket(
        sm.marketIndex
      );
      return oracle.price.toNumber() / PRICE_PRECISION.toNumber();
    }
  }

  marketBidAsk(market = this.market): UiL3BidAsk {
    if (market.marketType === MarketType.SPOT) {
      const sm = this.driftClient
        .getSpotMarketAccounts()
        .find((m) => m.marketIndex === market.marketIndex);
      if (!sm) {
        throw new Error(`Spot market [${market.marketIndex}] not found`);
      }
      const l3 = this.dlobSubscriber.getL3({
        marketIndex: sm.marketIndex,
        marketType: MarketType.SPOT,
      });
      const bestAsk = l3.asks[0];
      if (!bestAsk) {
        throw new Error('No best ask');
      }
      const bestBid = l3.bids[0];
      if (!bestBid) {
        throw new Error('No best bid');
      }
      return {
        ask: {
          price: bestAsk.price.toNumber() / PRICE_PRECISION.toNumber(),
          size: bestAsk.size.toNumber() / Math.pow(10, sm.decimals),
          maker: bestAsk.maker,
          orderId: bestAsk.orderId,
        },
        bid: {
          price: bestBid.price.toNumber() / PRICE_PRECISION.toNumber(),
          size: bestBid.size.toNumber() / Math.pow(10, sm.decimals),
          maker: bestBid.maker,
          orderId: bestBid.orderId,
        },
      };
    } else {
      const pm = this.driftClient
        .getPerpMarketAccounts()
        .find((m) => m.marketIndex === market.marketIndex);
      if (!pm) {
        throw new Error(`Perp market [${market.marketIndex}] not found`);
      }
      const l3 = this.dlobSubscriber.getL3({
        marketIndex: pm.marketIndex,
        marketType: MarketType.PERP,
      });
      const bestAsk = l3.asks[0];
      if (!bestAsk) {
        throw new Error('No best ask');
      }
      const bestBid = l3.bids[0];
      if (!bestBid) {
        throw new Error('No best bid');
      }
      return {
        ask: {
          price: bestAsk.price.toNumber() / PRICE_PRECISION.toNumber(),
          size: bestAsk.size.toNumber() / BASE_PRECISION.toNumber(),
          maker: bestAsk.maker,
          orderId: bestAsk.orderId,
        },
        bid: {
          price: bestBid.price.toNumber() / PRICE_PRECISION.toNumber(),
          size: bestBid.size.toNumber() / BASE_PRECISION.toNumber(),
          maker: bestBid.maker,
          orderId: bestBid.orderId,
        },
      };
    }
  }

  async cancelOrdersIxs(): Promise<TransactionInstruction[]> {
    const ixs: TransactionInstruction[] = [];
    for (const order of this.fundUser.getOpenOrders()) {
      ixs.push(await this.driftClient.getCancelOrderIx(order.orderId));
    }
    return ixs;
  }

  async cancelOrders(): Promise<SnackInfo> {
    const ixs = await this.cancelOrdersIxs();
    if (ixs.length > 0) {
      return await this.sendTx(
        ixs,
        'Cancelled open orders',
        'Failed to cancel open orders',
        async () => {
          await this.fundUser.fetchAccounts();
        }
      );
    } else {
      return {
        variant: 'success',
        message: 'No open orders to cancel',
      };
    }
  }

  async placeMarketPerpOrder(
    usdc: number,
    direction: PositionDirection,
    market = this.market,
    slippagePct = 0.5,
    cancelOrders = false
  ): Promise<SnackInfo> {
    if (market.marketType !== MarketType.PERP) {
      return {
        variant: 'error',
        message: 'Market must be a perpetual market',
      };
    }
    const price = this.oraclePrice(market);

    let priceDiffBps;
    if (direction === PositionDirection.LONG) {
      priceDiffBps = price * (1 + slippagePct / 100);
    } else {
      priceDiffBps = price * (1 - slippagePct / 100);
    }

    const baseUnits = usdc / price;

    const activeUser = this.driftClient.getUser(0, this.fundKey);
    const fundAcct = (await this.program.account.vault.fetch(
      this.fundKey
    )) as Vault;
    console.log(
      'fund user correct:',
      fundAcct.user.equals(activeUser.getUserAccountPublicKey())
    );
    console.log('fund delegate correct:', fundAcct.delegate.equals(this.key));

    const orderParams = getMarketOrderParams({
      marketIndex: market.marketIndex,
      direction,
      baseAssetAmount: this.driftClient.convertToPerpPrecision(baseUnits),
      auctionStartPrice: this.driftClient.convertToPricePrecision(price),
      auctionEndPrice: this.driftClient.convertToPricePrecision(priceDiffBps),
      price: this.driftClient.convertToPricePrecision(priceDiffBps),
      auctionDuration: 60,
      maxTs: new BN(Date.now() + 100),
    });

    const remainingAccounts = this.driftClient.getRemainingAccounts({
      userAccounts: [activeUser.getUserAccount()],
      useMarketLastSlotCache: true,
      writablePerpMarketIndexes: [market.marketIndex],
    });

    try {
      const ixs: TransactionInstruction[] = [];
      if (cancelOrders) {
        const cancelIxs = await this.cancelOrdersIxs();
        ixs.push(...cancelIxs);
      }
      const ix = await this.driftClient.program.methods
        .placePerpOrder(orderParams)
        .accounts({
          state: await this.driftClient.getStatePublicKey(),
          user: activeUser.userAccountPublicKey,
          authority: this.key,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();
      ixs.push(ix);
      return await this.sendTx(
        ixs,
        `Market order placed starting at $${price.toFixed(2)}`,
        'Failed to place market order'
      );
    } catch (e: any) {
      console.error(e);
      return {
        variant: 'error',
        message: JSON.stringify(e),
      };
    }
  }
}
