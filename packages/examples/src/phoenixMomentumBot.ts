import {AccountMeta, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction,} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {BN} from '@coral-xyz/anchor';
import {
  CreateVaultConfig,
  Data,
  FundOverview,
  PhoenixAccountEvents,
  PhoenixAccountSubscription,
  PhoenixMarketSubscriber,
  PhoenixVaultsClient,
  signatureLink,
  sleep,
  SnackInfo,
  UiL2BidAsk
} from '@cosmic-lab/prop-shop-sdk';
import {AsyncSigner, keypairToAsyncSigner, walletAdapterToAsyncSigner,} from '@cosmic-lab/data-source';
import * as splToken from '@solana/spl-token';
import {WalletContextState} from '@solana/wallet-adapter-react';
import {err, ok, Result} from 'neverthrow';
import {MarketPriceInfo, RingBuffer, StandardTimeframe, Timeframe,} from './types';
import {Client as PhoenixClient, MarketState, toNum} from '@ellipsis-labs/phoenix-sdk';
import {encodeName, getMarketRegistryAddressSync, getVaultAddressSync, OrderSide, PhoenixVaults} from "@cosmic-lab/phoenix-vaults-sdk";
import StrictEventEmitter from "strict-event-emitter-types";
import {EventEmitter} from "events";

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
 * const bot = await PhoenixMomentumBot.fromKeypair(connection, keypair, 'fundName');
 * await bot.start(); // or manually call functions if used for other purposes
 * ```
 */
export class PhoenixMomentumBot {
  private readonly conn: Connection;
  // AsyncSigner is a unified interface that a wallet (UI) or keypair (bot) can implement.
  // It prevents the need for conditional logic to handle a wallet or keypair.
  private signer: AsyncSigner;
  key: PublicKey;
  private client: PhoenixVaultsClient;
  private _marketSubscriber: PhoenixMarketSubscriber | undefined;
  private eventEmitter: StrictEventEmitter<
    EventEmitter,
    PhoenixAccountEvents
  > = new EventEmitter();
  private _markets = new Map<string, MarketState>();
  readonly fundName: string;
  private running = false;
  private readonly market: PublicKey;
  private marketCache: RingBuffer<MarketPriceInfo>;
  private timeframe: Timeframe;
  private readonly simulate: boolean;

  /**
   * Create a new PhoenixMomentumBot from a keypair (bot) and initialize in one step
   * @param params
   * @param connection - Solana RPC connection
   * @param keypair - Transaction payer and authority of the Prop Shop fund
   * @param fundName - Name of the Prop Shop fund to manage
   * @param market - market index and spot/perp type
   * @param marketCacheSize - Number of market prices to cache
   * @param tf - Timeframe to use for trading
   * @param simulate - Simulate transaction instead of sending
   * @returns PhoenixMomentumBot
   */
  static async fromKeypair(params: {
    connection: Connection;
    keypair: Keypair;
    fundName: string;
    market: PublicKey;
    marketCacheSize?: number;
    tf?: StandardTimeframe;
    simulate?: boolean;
  }): Promise<PhoenixMomentumBot> {
    const {keypair, ...rest} = params;
    const self = new PhoenixMomentumBot({
      signer: keypairToAsyncSigner(keypair),
      ...rest,
    });
    await self.initialize();
    return self;
  }

  /**
   * Create a new PhoenixMomentumBot from a wallet (UI) and initialize in one step
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
    market: PublicKey;
    marketCacheSize?: number;
    tf?: StandardTimeframe;
    simulate?: boolean;
  }): Promise<PhoenixMomentumBot> {
    const {wallet, ...rest} = params;
    const self = new PhoenixMomentumBot({
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
    market: PublicKey;
    marketCacheSize?: number;
    tf?: StandardTimeframe;
    simulate?: boolean;
  }) {
    this.conn = params.connection;
    this.signer = params.signer;
    this.key = params.signer.publicKey();
    this.fundName = params.fundName;
    this.client = new PhoenixVaultsClient({
      signer: params.signer,
      connection: params.connection,
    });
    this.market = params.market;
    this.marketCache = new RingBuffer<MarketPriceInfo>(
      params.marketCacheSize ?? 3
    );
    this.timeframe = new Timeframe(params.tf ?? StandardTimeframe.THIRTY_MINUTES);
    this.simulate = params.simulate ?? false;

    this.eventEmitter.on(
      'market',
      async (payload: Data<PublicKey, MarketState>) => {
        const update = JSON.stringify(payload.data);
        const existing = JSON.stringify(
          this._markets.get(payload.key.toString())
        );
        if (update !== existing) {
          this._markets.set(payload.key.toString(), payload.data);
        }
      }
    );
  }

  async initialize(): Promise<void> {
    await this.client.initialize();

    const markets = Array.from(this.phoenixClient.marketStates.keys())
      .map((k) => {
        return {
          publicKey: new PublicKey(k)
        } as PhoenixAccountSubscription;
      }) as PhoenixAccountSubscription[];
    this._marketSubscriber = new PhoenixMarketSubscriber(
      this.conn,
      {
        accounts: markets
      },
      this.eventEmitter
    );
    await this._marketSubscriber.subscribe();
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
    await this.marketSubscriber.unsubscribe();
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
    while (this.running) {
      const {bid, ask} = this.marketBidAsk();
      this.marketCache.push({
        bid,
        ask,
        oracle: (bid.price + ask.price) / 2
      });
      console.log(`
        💡Market update,
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
          const _snack = await this.placeLimitOrder({
            side: OrderSide.BID,
            cancelOrders: true
          });
        } else if (rsi > rsiSellThreshold) {
          console.log(
            `🔴 RSI: ${rsi.toFixed(2)} > ${rsiSellThreshold}, go short!`
          );
          const _snack = await this.placeLimitOrder({
            side: OrderSide.ASK,
            cancelOrders: true,
          });
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

  get phoenixClient(): PhoenixClient {
    return this.client.phoenixClient;
  }

  get marketSubscriber(): PhoenixMarketSubscriber {
    if (!this._marketSubscriber) {
      throw new Error('PhoenixMarketSubscriber not initialized');
    }
    return this._marketSubscriber;
  }

  get program(): anchor.Program<PhoenixVaults> {
    return this.client.program;
  }

  getMarket(market: PublicKey): MarketState | undefined {
    return this._markets.get(market.toString());
  }

  getMarketOrErr(market: PublicKey): MarketState {
    const value = this._markets.get(market.toString());
    if (!value) {
      throw new Error(`Market [${market}] not found`);
    }
    return value;
  }

  get marketAccountMetas(): AccountMeta[] {
    return Array.from(this._markets.keys()).map((k) => {
      return {
        pubkey: new PublicKey(k),
        isWritable: false,
        isSigner: false,
      } as AccountMeta;
    });
  }


  get fundKey(): PublicKey {
    return getVaultAddressSync(encodeName(this.fundName));
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
    return (await this.client.createVault(config)).snack;
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
    const registry = await this.program.account.marketRegistry.fetch(
      getMarketRegistryAddressSync()
    );
    if (!registry) {
      return err('MarketRegistry not found');
    }
    const usdcMintData = await splToken.getMint(this.conn, registry.usdcMint);
    if (usdcMintData.mintAuthority === null) {
      return err('Mint authority not found');
    }
    return ok({
      mint: registry.usdcMint,
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

  /*
    * Uses the best bid on the market's orderbook as the price.
    * Bid is used instead of ask because the fund would likely want to know the price it could sell at
    * in order to liquidation assets to fulfill investor withdrawals.
   */
  marketPrice(market = this.market): number {
    const marketState = this.getMarketOrErr(market);
    return marketState.getUiLadder(1, 0, 0).bids[0].price;
  }

  marketBidAsk(market = this.market): UiL2BidAsk {
    const marketState = this.getMarketOrErr(market);
    const ladder = marketState.getUiLadder(1, 0, 0);
    return {
      bid: {
        price: ladder.asks[0].price,
        size: ladder.asks[0].quantity
      },
      ask: {
        price: ladder.bids[0].price,
        size: ladder.bids[0].quantity
      }
    };
  }

  openOrders(market = this.market): {
    side: OrderSide;
    orderSequenceNumber: BN;
    priceInTicks: BN;
    baseLots: BN;
  }[] {
    const marketState = this.getMarketOrErr(market);
    const traderState = marketState.data.traders.get(this.fundKey.toString());
    if (!traderState) {
      throw Error(`TraderState not found for fund ${this.fundKey.toString()}`);
    }
    const traderIndex = marketState.data.traderPubkeyToTraderIndex.get(this.fundKey.toString());
    const orders = [];

    for (const [orderId, order] of marketState.data.bids) {
      if (toNum(order.traderIndex) === traderIndex) {
        let orderSequenceNumber: BN;
        if (orderId.orderSequenceNumber instanceof BN) {
          orderSequenceNumber = orderId.orderSequenceNumber;
        } else {
          orderSequenceNumber = new BN(orderId.orderSequenceNumber as number);
        }

        let priceInTicks: BN;
        if (orderId.priceInTicks instanceof BN) {
          priceInTicks = orderId.priceInTicks;
        } else {
          priceInTicks = new BN(orderId.priceInTicks as number);
        }

        let baseLots: BN;
        if (order.numBaseLots instanceof BN) {
          baseLots = order.numBaseLots;
        } else {
          baseLots = new BN(order.numBaseLots as number);
        }

        const bid = {
          side: OrderSide.BID,
          orderSequenceNumber,
          priceInTicks,
          baseLots,
        };
        orders.push(bid);
      }
    }

    for (const [orderId, order] of marketState.data.asks) {
      if (toNum(order.traderIndex) === traderIndex) {
        let orderSequenceNumber: BN;
        if (orderId.orderSequenceNumber instanceof BN) {
          orderSequenceNumber = orderId.orderSequenceNumber;
        } else {
          orderSequenceNumber = new BN(orderId.orderSequenceNumber as number);
        }

        let priceInTicks: BN;
        if (orderId.priceInTicks instanceof BN) {
          priceInTicks = orderId.priceInTicks;
        } else {
          priceInTicks = new BN(orderId.priceInTicks as number);
        }

        let baseLots: BN;
        if (order.numBaseLots instanceof BN) {
          baseLots = order.numBaseLots;
        } else {
          baseLots = new BN(order.numBaseLots as number);
        }

        const ask = {
          side: OrderSide.ASK,
          orderSequenceNumber,
          priceInTicks,
          baseLots,
        };
        orders.push(ask);
      }
    }
    return orders;
  }

  /*
   * By default this cancels every open order.
   * If you want to specify specific orders, then filter the array returned from `this.openOrders()`
   */
  async cancelOrdersIx(): Promise<TransactionInstruction> {
    const marketState = this.getMarketOrErr(this.market);
    return this.client.cancelOrdersIx(this.fundKey, marketState);
  }

  async cancelOrders(): Promise<SnackInfo> {
    const ix = await this.cancelOrdersIx();
    return await this.sendTx(
      [ix],
      'Cancelled open orders',
      'Failed to cancel open orders',
    );
  }

  async placeLimitOrder(params: {
    side: OrderSide,
    market?: PublicKey,
    cancelOrders?: boolean,
    price?: number
  }): Promise<SnackInfo> {
    const market = params.market ?? this.market;
    const cancelOrders = params.cancelOrders ?? false;

    const marketState = this.getMarketOrErr(market);
    const ixs = [];
    if (cancelOrders) {
      ixs.push(await this.client.cancelOrdersIx(
        this.fundKey,
        marketState
      ));
    }
    ixs.push(await this.client.placeLimitOrderIx({
      vaultKey: this.fundKey,
      marketState,
      side: params.side,
      price: params.price,
    }));
    return await this.sendTx(
      ixs,
      `Placed ${params.side} limit order`,
      `Failed to place ${params.side} limit order`,
    );
  }
}
