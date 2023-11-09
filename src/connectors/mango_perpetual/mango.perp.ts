import BN from 'bn.js';
import LRUCache from 'lru-cache';
import { Solana } from '../../chains/solana/solana';
import { getSolanaConfig } from '../../chains/solana/solana.config';
import {
  ClobDeleteOrderRequestExtract,
  CreatePerpOrderParam,
  extractPerpOrderParams,
  FundingInfo,
  Orderbook,
  PerpClobBatchUpdateRequest,
  PerpClobDeleteOrderRequest,
  PerpClobFundingInfoRequest,
  PerpClobFundingPaymentsRequest,
  PerpClobGetLastTradePriceRequest,
  PerpClobGetOrderRequest,
  PerpClobGetTradesRequest,
  PerpClobMarketRequest,
  PerpClobMarkets,
  PerpClobOrderbookRequest,
  PerpClobPositionRequest,
  PerpClobPostOrderRequest,
  PerpClobTickerRequest,
} from '../../clob/clob.requests';
import {
  NetworkSelectionRequest,
  PriceLevel,
} from '../../services/common-interfaces';
import { MangoConfig } from './mango.config';
import {
  Group,
  HealthType,
  I80F48,
  MANGO_V4_ID,
  MangoAccount,
  MangoClient,
  PerpMarket,
  PerpMarketIndex,
  PerpOrder,
  PerpPosition,
  toUiDecimalsForQuote,
} from '@blockworks-foundation/mango-v4';
import {
  FundingPayment,
  Market,
  PerpTradeActivity,
  Position,
} from './mango.types';
import {
  randomInt,
  translateOrderSide,
  translateOrderType,
  OrderTracker,
  OrderStatus,
  OrderTrackingInfo,
} from './mango.utils';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { mangoDataApi, MangoDataApi } from './mango.api';
import { max } from 'mathjs';
import Dict = NodeJS.Dict;
import { BalanceRequest } from '../../network/network.requests';
import Decimal from 'decimal.js-light';

type OrderIdentifier = {
  clientOrderId: number;
  expiryTimestamp: string;
};

type IdentifiedOrder = {
  clientOrderId: string;
  exchangeOrderId: string;
};

type IdentifiablePostOrdersIxs = {
  instructions: TransactionInstruction[];
  identifiers: OrderIdentifier[];
};

export class MangoClobPerp {
  private static _instances: LRUCache<string, MangoClobPerp>;
  private readonly _chain: Solana;
  private readonly _client: MangoClient;
  private readonly _orderTracker: OrderTracker;
  public derivativeApi: MangoDataApi;
  public mangoGroupPublicKey: PublicKey;
  public mangoGroup: Group;
  public conf: MangoConfig.NetworkConfig;

  private _ready: boolean = false;
  // private _lastTradePrice: number = 0;
  public parsedMarkets: PerpClobMarkets<PerpMarket> = {};
  // @note: Contains all MangoAccounts, grouped by owner address and base asset
  public mangoAccounts: Dict<Dict<MangoAccount>> = {};

  private constructor(_chain: string, network: string) {
    this._chain = Solana.getInstance(network);
    this._client = this.connectMangoClient(new Keypair());
    this._orderTracker = new OrderTracker();
    this.derivativeApi = mangoDataApi;
    this.mangoGroupPublicKey = new PublicKey(MangoConfig.defaultGroup);
    this.mangoGroup = {} as Group;
    this.conf = MangoConfig.config;
  }

  public static getInstance(chain: string, network: string): MangoClobPerp {
    if (MangoClobPerp._instances === undefined) {
      const config = getSolanaConfig(chain, network);
      MangoClobPerp._instances = new LRUCache<string, MangoClobPerp>({
        max: config.network.maxLRUCacheInstances,
      });
    }
    const instanceKey = chain + network;
    if (!MangoClobPerp._instances.has(instanceKey)) {
      MangoClobPerp._instances.set(
        instanceKey,
        new MangoClobPerp(chain, network)
      );
    }

    return MangoClobPerp._instances.get(instanceKey) as MangoClobPerp;
  }

  public async loadMarkets(group: Group) {
    // @note: Mango allows for groups that include a selection of markets in one cross-margin basket,
    //        but we are only supporting one group per Gateway instance for now. You can change the
    //        group in the config file (mango.defaultGroup)
    const derivativeMarkets = await this._client.perpGetMarkets(group);
    for (const market of derivativeMarkets) {
      const key = market.name;
      this.parsedMarkets[key] = market;
    }
  }

  public async init() {
    if (!this._chain.ready() || Object.keys(this.parsedMarkets).length === 0) {
      await this._chain.init();
      this.mangoGroup = await this._client.getGroup(this.mangoGroupPublicKey);
      await this.loadMarkets(this.mangoGroup);
      this._ready = true;
    }
  }

  public ready(): boolean {
    return this._ready;
  }

  /**
   * Returns a MangoClient instance that is connected to the Solana network
   * @note: This is an alternative way to connect to the MangoClient, because the connectDefaults will
   *       spam requests to the Solana cluster causing rate limit errors.
   */
  private connectMangoClient(
    keypair: Keypair,
    isAPI: boolean = true
  ): MangoClient {
    const clientKeypair = keypair;
    const options = AnchorProvider.defaultOptions();
    const connection = new Connection(this._chain.rpcUrl, options);

    const clientWallet = new Wallet(clientKeypair);
    const clientProvider = new AnchorProvider(connection, clientWallet, {
      ...options,
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    const idsSource = isAPI ? 'api' : 'get-program-accounts';

    return MangoClient.connect(
      clientProvider,
      'mainnet-beta',
      MANGO_V4_ID['mainnet-beta'],
      {
        idsSource,
      }
    );
  }

  /**
   * Returns a context object for sending transactions with a stored wallet.
   */
  private async getProvider(address: string): Promise<AnchorProvider> {
    const wallet = new Wallet(await this._chain.getKeypair(address));
    const options = AnchorProvider.defaultOptions();

    return new AnchorProvider(this._chain.connection, wallet, options);
  }

  private getExistingMangoAccount(
    address: string,
    market: string
  ): MangoAccount | undefined {
    const userAccounts = this.mangoAccounts[address];
    return userAccounts === undefined ? undefined : userAccounts[market];
  }

  /**
   * Accepts a user's public key and a market name as used inside Mango (BTC-PERP, MNGO-PERP, ...)
   * This method makes sure that all existent accounts are being fetched, the first time a user is looking for his
   * MangoAccounts. Each combination of user address and market name have their own MangoAccount in order to realize
   * isolated margin-style positions.
   */
  private async getOrCreateMangoAccount(
    address: string,
    market: string
  ): Promise<MangoAccount> {
    let foundAccount = this.getExistingMangoAccount(address, market);
    if (foundAccount) return foundAccount;

    // check if user has been initialized and accounts fetched
    if (this.mangoAccounts[address] === undefined) {
      foundAccount = await this.fetchExistingAccounts(
        address,
        market,
        foundAccount
      );
      if (foundAccount) return foundAccount;
    }

    // get accounts and find accountNumber to use to create new MangoAccount
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const accounts = Object.values(this.mangoAccounts[address]!).filter(
      (account) => {
        return account !== undefined;
      }
    ) as MangoAccount[];
    const usedIndexes = accounts.map((account) => account.accountNum).sort();
    const accountNumber = usedIndexes.length > 0 ? max(usedIndexes) + 1 : 0;
    const addressKeyPair = await this._chain.getKeypair(address);

    if (addressKeyPair === undefined) {
      throw Error(
        `MangoAccount creation failure: ${market} - in group ${this.mangoGroup} for wallet ${address}\nInvalid KeyPair?`
      );
    }

    // @todo: Check if there is account space optimization possible with tokenCount
    try {
      const tempClient = this.connectMangoClient(addressKeyPair);
      console.log('Creating account: ', accountNumber, market);
      await tempClient.createMangoAccount(
        this.mangoGroup,
        accountNumber,
        market,
        2
      );
    } catch (error) {
      throw Error(
        `MangoAccount creation failure: ${market} - in group ${this.mangoGroup.publicKey.toString()} for wallet ${address}\nError: ${error}`
      );
    }

    const updatedAccounts = await this._client.getMangoAccountsForOwner(
      this.mangoGroup,
      new PublicKey(address)
    );

    const newAccount = updatedAccounts.find(
      (account) => account.accountNum === accountNumber
    );

    if (newAccount === undefined)
      throw Error(
        `MangoAccount creation failure: ${market} - in group ${this.mangoGroup} for wallet ${address}\nDo you have enough SOL?`
      );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.mangoAccounts[address]![market] = newAccount;
    return newAccount;
  }

  private async fetchExistingAccounts(
    address: string,
    market: string | undefined,
    foundAccount: MangoAccount | undefined
  ) {
    this.mangoAccounts[address] = {};
    const accounts = await this._client.getMangoAccountsForOwner(
      this.mangoGroup,
      new PublicKey(address)
    );
    accounts.forEach((account) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.mangoAccounts[address]![account.name] = account;
      if (market && account.name === market) foundAccount = account;
    });

    return foundAccount;
  }

  public async markets(
    req: PerpClobMarketRequest
  ): Promise<{ markets: PerpClobMarkets<Market> }> {
    if (req.market && req.market.split('-').length === 2) {
      const resp: PerpClobMarkets<Market> = {};
      const market = this.parsedMarkets[req.market];

      resp[req.market] = {
        name: market.name,
        miniumOrderSize: market.minOrderSize,
        tickSize: market.tickSize,
        minQuoteAmountIncrement: market.quoteLotsToUi(new BN(1)),
        minBaseAmountIncrement: market.baseLotsToUi(new BN(1)),
        takerFee: market.takerFee.toNumber(),
        makerFee: market.makerFee.toNumber(),
      };

      return { markets: resp };
    }

    const mappedMarkets = Object.keys(this.parsedMarkets).reduce(
      (acc, marketName) => {
        const market = this.parsedMarkets[marketName];
        acc[marketName] = {
          name: market.name,
          miniumOrderSize: market.minOrderSize,
          tickSize: market.tickSize,
          minQuoteAmountIncrement: market.quoteLotsToUi(new BN(1)),
          minBaseAmountIncrement: market.baseLotsToUi(new BN(1)),
          takerFee: market.takerFee.toNumber(),
          makerFee: market.makerFee.toNumber(),
        };
        return acc;
      },
      {} as PerpClobMarkets<Market>
    );

    return { markets: mappedMarkets };
  }

  public async orderBook(
    req: PerpClobOrderbookRequest
  ): Promise<Orderbook<any>> {
    const market = this.parsedMarkets[req.market];

    // @note: use getL2Ui to get the correct price levels
    const bids = (await market.loadBids(this._client)).getL2Ui(10);
    const asks = (await market.loadAsks(this._client)).getL2Ui(10);

    // @note: currently all timestamp are the same
    const currentTime = Date.now();
    const buys: PriceLevel[] = [];
    const sells: PriceLevel[] = [];

    bids.forEach((bid) => {
      buys.push({
        price: bid[0].toString(),
        quantity: bid[1].toString(),
        timestamp: currentTime,
      });
    });

    asks.forEach((ask) => {
      sells.push({
        price: ask[0].toString(),
        quantity: ask[1].toString(),
        timestamp: currentTime,
      });
    });

    return {
      buys,
      sells,
    };
  }

  // private async loadFills(market: PerpMarket): Promise<PerpMarketFills> {
  //   return {
  //     marketName: market.name,
  //     fills: await market.loadFills(this._client),
  //   };
  // }

  public async ticker(
    req: PerpClobTickerRequest
  ): Promise<{ markets: PerpClobMarkets<Market> }> {
    return await this.markets(req);
  }

  public async lastTradePrice(
    req: PerpClobGetLastTradePriceRequest
  ): Promise<string | null> {
    // TODO: fills return empty, get stable price as temp fix
    await this.mangoGroup.reloadPerpMarkets(this._client);
    const market = this.parsedMarkets[req.market];
    const bank = this.mangoGroup.getFirstBankByTokenIndex(
      market.settleTokenIndex
    );
    const base = market.name.split('-')[0];
    const decimals = <string>bank.mintDecimals.toString();
    const stableDecimals = base === 'SOL' ? 3 : 6;

    const stablePrice = I80F48.fromString(
      market.stablePriceModel.stablePrice.toString()
    );

    return stablePrice
      .mul(I80F48.fromString(`1e${decimals}`))
      .div(I80F48.fromString(`1e${stableDecimals}`))
      .toString();
  }

  public async trades(
    req: PerpClobGetTradesRequest
  ): Promise<Array<PerpTradeActivity>> {
    const mangoAccount = await this.getOrCreateMangoAccount(
      req.address,
      req.market
    );

    const trades = await this.derivativeApi.fetchPerpTradeHistory(
      mangoAccount.publicKey.toBase58()
    );

    let targetTrade = undefined;

    if (req.orderId !== undefined) {
      for (const trade of trades) {
        if (
          trade.taker_client_order_id === req.orderId ||
          trade.taker_order_id === req.orderId ||
          trade.maker_order_id === req.orderId
        ) {
          targetTrade = trade;
          break;
        }
      }
    }

    if (req.orderId !== undefined) {
      return targetTrade ? [targetTrade] : [];
    } else {
      return trades;
    }
  }

  // TODO: Add test
  public async balances(req: BalanceRequest): Promise<Record<string, string>> {
    if (req.tokenSymbols.find((symbol) => symbol === 'PERP')) {
      req.tokenSymbols.push('USDC');
      req.tokenSymbols.splice(req.tokenSymbols.indexOf('PERP'), 1);
    }

    let mangoAccounts = this.mangoAccounts[req.address];

    if (mangoAccounts === undefined) {
      await this.fetchExistingAccounts(req.address, undefined, undefined);
      mangoAccounts = this.mangoAccounts[req.address];
    }

    if (mangoAccounts === undefined) {
      return {};
    }

    const balancesMap: Map<string, string> = new Map<string, string>();
    for (const [, account] of Object.entries(mangoAccounts)) {
      if (account === undefined) continue;
      for (const token of account.tokensActive()) {
        const bank = this.mangoGroup.getFirstBankByTokenIndex(token.tokenIndex);
        const amount = token
          .balance(bank)
          .div(I80F48.fromString(`1e${bank.mintDecimals}`));
        const symbol = bank.name;
        if (balancesMap.get(symbol) === undefined) {
          balancesMap.set(symbol, amount.toString());
        } else {
          const newAmount = new Decimal(balancesMap.get(symbol)!).add(
            new Decimal(amount.toString())
          );
          balancesMap.set(symbol, newAmount.toString());
        }
      }
    }

    const balances: Record<string, string> = {};
    for (const [key, value] of balancesMap.entries()) {
      balances[key] = value;
    }
    return balances;
  }

  public async orders(
    req: PerpClobGetOrderRequest
  ): Promise<Array<OrderTrackingInfo>> {
    const mangoAccount = await this.getOrCreateMangoAccount(
      req.address,
      req.market
    );

    const orders = await mangoAccount.loadPerpOpenOrdersForMarket(
      this._client,
      this.mangoGroup,
      this.parsedMarkets[req.market].perpMarketIndex,
      true
    );

    for (const order of orders) {
      this.processOrderUpdate(order);
    }

    console.log(
      '🪧 -> file: mango.perp.ts:429 -> MangoClobPerp -> processOrderUpdate:',
      this._orderTracker.getAllOrderTrackingInfo()
    );

    if (req.orderId !== undefined) {
      this.processTargetedOrderUpdate(orders, req.orderId);
    }

    if (req.orderId !== undefined) {
      const targetOrder =
        this._orderTracker.getOrderTrackingInfoByExchangeOrderId(req.orderId);

      return targetOrder ? [targetOrder] : [];
    } else if (req.clientOrderId !== undefined) {
      const targetOrder = this._orderTracker.getOrderTrackingInfo(
        req.clientOrderId
      );

      return targetOrder ? [targetOrder] : [];
    } else {
      return this._orderTracker.getAllOrderTrackingInfo();
    }
  }

  private processTargetedOrderUpdate(
    orders: PerpOrder[],
    exchangeOrderId: string
  ) {
    const targetOrder =
      this._orderTracker.getOrderTrackingInfoByExchangeOrderId(exchangeOrderId);

    if (targetOrder === undefined) {
      // TODO: Order is not tracked for some reason, put some error here to investigate
      return;
    }

    for (const order of orders) {
      if (order.orderId.toString() === exchangeOrderId) {
        // Found the order, meaning it is still open
        return;
      }
    }

    // Order is not found, meaning it is closed
    // Unless order is already CANCELLED, FILLED or EXPIRED, update the status
    if (
      targetOrder.status !== OrderStatus.PENDING_CANCEL &&
      targetOrder.status !== OrderStatus.CANCELLED &&
      targetOrder.status !== OrderStatus.FILLED &&
      targetOrder.status !== OrderStatus.EXPIRED
    ) {
      this._orderTracker.updateOrderStatusByExchangeOrderId(
        exchangeOrderId,
        OrderStatus.FILLED
      );
    } else if (targetOrder.status === OrderStatus.PENDING_CANCEL) {
      this._orderTracker.updateOrderStatusByExchangeOrderId(
        exchangeOrderId,
        OrderStatus.CANCELLED
      );
    }
  }

  private processOrderUpdate(order: PerpOrder) {
    const trackingInfo =
      this._orderTracker.getOrderTrackingInfoByExchangeOrderId(
        order.orderId.toString()
      );

    if (trackingInfo !== undefined) {
      const currentAmount = order.uiSize;
      const initialAmount = parseFloat(trackingInfo.orderAmount);

      if (order.isExpired) {
        this._orderTracker.updateOrderStatusByExchangeOrderId(
          order.orderId.toString(),
          OrderStatus.EXPIRED,
          (initialAmount - currentAmount).toString()
        );

        return;
      }

      if (currentAmount < initialAmount) {
        this._orderTracker.updateOrderStatusByExchangeOrderId(
          order.orderId.toString(),
          OrderStatus.PARTIALLY_FILLED,
          (initialAmount - currentAmount).toString()
        );

        return;
      }
    } else {
      return;
    }
  }

  public static calculateMargin(
    price: string,
    quantity: string,
    leverage: number
  ): I80F48 {
    /**
     * Returns the margin required for a PerpOrder in USDC
     */
    const priceBig = I80F48.fromString(price);
    const quantityBig = I80F48.fromString(quantity);
    const leverageBig = I80F48.fromString(leverage.toString());

    return priceBig.mul(quantityBig).div(leverageBig);
  }

  public getFreeCollateral(mangoAccount: MangoAccount) {
    /**
     * Returns the free collateral of a MangoAccount in USDC
     */
    const decimals = <string>(
      this.mangoGroup.banksMapByName.get('USDC')?.[0].mintDecimals.toString()
    );
    const decimalsBig = I80F48.fromString('1e' + decimals);
    return mangoAccount
      .getHealth(this.mangoGroup, HealthType.init)
      .div(decimalsBig);
  }

  private mapClientOrderIDs(result: {
    txHash: string;
    identifiedOrders: IdentifiedOrder[] | undefined;
  }) {
    // TODO: should return { txHash, [{clientId1, exchangeId1}, {clientId2, exchangeId2}] } instead
    return {
      txHash: result.txHash,
      exchangeOrderId:
        result.identifiedOrders?.map(
          (identifiedOrder) => identifiedOrder.exchangeOrderId
        ) ?? [],
    };
  }

  public async postOrder(req: PerpClobPostOrderRequest): Promise<{
    txHash: string;
    clientOrderId?: string | string[];
  }> {
    if (req.clientOrderId !== undefined) {
      this._orderTracker.addOrder(
        req.clientOrderId,
        req.amount,
        req.price,
        req.side
      );
    } else {
      throw Error('Client order ID is required');
    }

    const result = await this.orderUpdate(req);
    return this.mapClientOrderIDs(result);
  }

  public async deleteOrder(req: PerpClobDeleteOrderRequest): Promise<{
    txHash: string;
    clientOrderId?: string | string[];
  }> {
    this._orderTracker.updateOrderStatusByExchangeOrderId(
      req.orderId,
      OrderStatus.PENDING_CANCEL
    );
    const result = await this.orderUpdate(req);
    return this.mapClientOrderIDs(result);
  }

  public async batchPerpOrders(req: PerpClobBatchUpdateRequest): Promise<{
    txHash: string;
    clientOrderId?: string | string[];
  }> {
    const result = await this.orderUpdate(req);
    return this.mapClientOrderIDs(result);
  }

  public estimateGas(_req: NetworkSelectionRequest): {
    gasPrice: number;
    gasPriceToken: string;
    gasLimit: number;
    gasCost: number;
  } {
    return {
      gasPrice: this._chain.gasPrice,
      gasPriceToken: this._chain.nativeTokenSymbol,
      gasLimit: this.conf.gasLimitEstimate,
      gasCost: this._chain.gasPrice * this.conf.gasLimitEstimate,
    };
  }

  public async fundingInfo(
    req: PerpClobFundingInfoRequest
  ): Promise<FundingInfo> {
    await this.mangoGroup.reloadPerpMarkets(this._client);
    await this.mangoGroup.reloadPerpMarketOraclePrices(this._client);
    const oraclePerpMarket = this.mangoGroup.getPerpMarketByName(req.market);
    const marketId = req.market;
    const indexPrice = oraclePerpMarket.price.toString();
    const markPrice = oraclePerpMarket.stablePriceModel.stablePrice.toString();

    // Get daily instantaneous funding rate
    const fr = oraclePerpMarket.getInstantaneousFundingRateUi(
      await oraclePerpMarket.loadBids(this._client),
      await oraclePerpMarket.loadAsks(this._client)
    );

    // @note: Funding is continuously applied on every interaction to a perp position.
    //        We should handle this differently from deterministic funding rate (e.g. every 8 hours)
    //        For now, let make it like a periodic thing (every 1 hour), and we can change it later
    const nextFundingTimestamp = Date.now() + 60 * 60 * 1000;

    return {
      marketId,
      indexPrice,
      markPrice,
      fundingRate: (fr / 24).toString(),
      nextFundingTimestamp: nextFundingTimestamp * 1e3,
    };
  }

  public async fundingPayments(
    req: PerpClobFundingPaymentsRequest
  ): Promise<Array<FundingPayment>> {
    const mangoAccount = await this.getOrCreateMangoAccount(
      req.address,
      req.market
    );

    // @note: take too long to fetch all funding payments
    const response = await this.derivativeApi.fetchFundingAccountHourly(
      mangoAccount.publicKey.toBase58()
    );

    const result: Record<string, Array<FundingPayment>> = {};
    Object.entries(response).forEach(([key, value]) => {
      result[key] = Object.entries(value).map(([key, value]) => {
        return {
          marketName: req.market,
          timestamp: Date.parse(key),
          amount: (value.long_funding + value.short_funding).toString(),
        };
      });
    });

    if (result[req.market] !== undefined) {
      // Filter out empty amounts
      result[req.market] = result[req.market].filter(
        (payment) => payment.amount !== '0'
      );
    } else {
      result[req.market] = [];
    }

    return result[req.market];
  }

  public async positions(
    req: PerpClobPositionRequest
  ): Promise<Array<Position>> {
    const marketIndexes = [];
    for (const market of req.markets) {
      marketIndexes.push(this.parsedMarkets[market].perpMarketIndex);
    }

    return await this.fetchPositions(marketIndexes, req.address);
  }

  private async fetchPositions(
    marketIndexes: PerpMarketIndex[],
    ownerPk: string
  ) {
    let positions: PerpPosition[] = [];
    let marketIndexesToQuery = marketIndexes;
    await this.mangoGroup.reloadPerpMarkets(this._client);
    await this.loadMarkets(this.mangoGroup);

    if (marketIndexes.length === 0) {
      marketIndexesToQuery = Object.values(this.parsedMarkets).map(
        (market) => market.perpMarketIndex
      );
    }

    for (const marketIndex of marketIndexesToQuery) {
      const market = Object.values(this.parsedMarkets).find(
        (market) => market.perpMarketIndex === marketIndex
      );

      const mangoAccount = await this.fetchExistingAccounts(
        ownerPk,
        market?.name,
        undefined
      );

      if (mangoAccount === undefined) {
        continue;
      }

      await mangoAccount.reload(this._client);

      const filteredPerpPositions = mangoAccount
        .perpActive()
        .filter((pp) => pp.marketIndex === marketIndex);

      positions = positions.concat(filteredPerpPositions);
    }

    console.log(
      '🪧 -> file: mango.perp.ts:826 -> MangoClobPerp -> positions:',
      positions
    );
    const mappedPositions: Position[] = [];

    positions.forEach((position) => {
      const side = position.basePositionLots.gte(new BN(0)) ? 'LONG' : 'SHORT'; // TODO: decide what happen if position lots is zero
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const market = Object.values(this.parsedMarkets).find(
        (market) => market.perpMarketIndex === position.marketIndex
      )!;
      const entryPrice = position.getAverageEntryPriceUi(market);
      const priceChange = market.stablePriceModel.stablePrice - entryPrice;

      const unrealizedPnl = toUiDecimalsForQuote(
        position.getBasePosition(market).mul(I80F48.fromNumber(priceChange))
      );

      mappedPositions.push({
        market: market.name,
        side,
        unrealizedPnl: unrealizedPnl.toString(),
        averageEntryPrice: entryPrice.toString(),
        amount: market.baseLotsToUi(position.basePositionLots.abs()).toString(),
        leverage: '1', // TODO: calculate leverage
      });
    });

    console.log(
      '🪧 -> file: mango.perp.ts:856 -> MangoClobPerp -> mappedPositions:',
      mappedPositions
    );

    // TODO: position calculation is not correct, need to fix

    return mappedPositions;
  }

  // private async buildPostOrder(
  //   client: MangoClient,
  //   provider: AnchorProvider,
  //   orders: CreatePerpOrderParam[]
  // ): Promise<TransactionInstruction[]> {
  //   const perpOrdersToCreate = [];
  //   for (const order of orders) {
  //     const mangoAccount = await this.getOrCreateMangoAccount(
  //       provider.wallet.publicKey.toBase58(),
  //       order.market
  //     );
  //     const market = this.parsedMarkets[order.market];
  //     perpOrdersToCreate.push(
  //       client.perpPlaceOrderV2Ix(
  //         this.mangoGroup,
  //         mangoAccount,
  //         market.perpMarketIndex,
  //         translateOrderSide(order.side),
  //         Number(order.price),
  //         Number(order.amount),
  //         undefined,
  //         Number(order.clientOrderId),
  //         translateOrderType(order.orderType)
  //       )
  //     );
  //   }
  //   return await Promise.all(perpOrdersToCreate);
  // }

  private async buildIdentifiablePostOrder(
    client: MangoClient,
    provider: AnchorProvider,
    orders: CreatePerpOrderParam[]
  ): Promise<IdentifiablePostOrdersIxs> {
    const perpOrdersToCreate = [];
    const identifiers: OrderIdentifier[] = [];
    const missingCollateral = new Map<string, I80F48>();
    for (const order of orders) {
      const mangoAccount = await this.getOrCreateMangoAccount(
        provider.wallet.publicKey.toBase58(),
        order.market
      );
      const market = this.parsedMarkets[order.market];
      const identifier = Math.floor(Date.now() / 1000) + randomInt(3600, 7200);
      const freeCollateral = this.getFreeCollateral(mangoAccount);
      const requiredMargin = MangoClobPerp.calculateMargin(
        order.price,
        order.amount,
        order.leverage
      );
      if (freeCollateral.lt(requiredMargin)) {
        if (missingCollateral.get(order.market) === undefined) {
          missingCollateral.set(
            order.market,
            requiredMargin.sub(freeCollateral)
          );
        } else {
          missingCollateral.set(
            order.market,
            <I80F48>missingCollateral.get(order.market)?.add(requiredMargin)
          );
        }
      }
      perpOrdersToCreate.push(
        client.perpPlaceOrderV2Ix(
          this.mangoGroup,
          mangoAccount,
          market.perpMarketIndex,
          translateOrderSide(order.side),
          Number(order.price),
          Number(order.amount),
          undefined,
          Number(order.clientOrderId),
          translateOrderType(order.orderType),
          undefined,
          undefined,
          identifier
        )
      );
      identifiers.push({
        clientOrderId: Number(order.clientOrderId),
        expiryTimestamp: identifier.toString(),
      });
    }

    for (const [market, amount] of missingCollateral.entries()) {
      const mangoAccount = await this.getOrCreateMangoAccount(
        provider.wallet.publicKey.toBase58(),
        market
      );
      try {
        const signature = await client.tokenDeposit(
          this.mangoGroup,
          mangoAccount,
          this.mangoGroup.banksMapByName.get('USDC')?.[0].mint as PublicKey,
          amount.toNumber()
        );
        console.info('Depositing tokens, signature: ', signature);
        if (signature.err) {
          throw Error(
            `Failed to deposit USDC for margin: ${signature.err.toString()}`
          );
        }
      } catch (error) {
        throw Error(`Failed to deposit USDC collateral: ${error}`);
      }
    }

    return {
      instructions: await Promise.all(perpOrdersToCreate),
      identifiers,
    };
  }

  private async buildDeleteOrder(
    client: MangoClient,
    provider: AnchorProvider,
    orders: ClobDeleteOrderRequestExtract[]
  ): Promise<TransactionInstruction[]> {
    const perpOrdersToCancel = [];
    for (const order of orders) {
      const mangoAccount = await this.getOrCreateMangoAccount(
        provider.wallet.publicKey.toBase58(),
        order.market
      );
      const market = this.parsedMarkets[order.market];
      perpOrdersToCancel.push(
        client.perpCancelOrderIx(
          this.mangoGroup,
          mangoAccount,
          market.perpMarketIndex,
          new BN(order.orderId)
        )
      );
    }
    return await Promise.all(perpOrdersToCancel);
  }

  public async orderUpdate(
    req:
      | PerpClobDeleteOrderRequest
      | PerpClobPostOrderRequest
      | PerpClobBatchUpdateRequest
  ): Promise<{
    txHash: string;
    identifiedOrders: IdentifiedOrder[] | undefined;
  }> {
    // TODO: Find out how much Compute Units each instruction type uses and batch them in one or multiple transactions
    // TODO: Transfer funds to MangoAccount if necessary
    const walletProvider = await this.getProvider(req.address);
    const addressKeyPair = await this._chain.getKeypair(req.address);
    const tempClient = this.connectMangoClient(addressKeyPair);
    const { perpOrdersToCreate, perpOrdersToCancel } =
      extractPerpOrderParams(req);

    // TODO: Hacky way to identify an order
    if (perpOrdersToCancel.length === 0 && perpOrdersToCreate.length >= 1) {
      const identifiedOrders: IdentifiedOrder[] = [];
      const payload = await this.buildIdentifiablePostOrder(
        tempClient,
        walletProvider,
        perpOrdersToCreate
      );

      const txSignature = await tempClient.sendAndConfirmTransaction(
        payload.instructions,
        {
          alts: this.mangoGroup.addressLookupTablesList,
          skipPreflight: true,
        }
      );

      const mangoAccount = await this.getOrCreateMangoAccount(
        req.address,
        perpOrdersToCreate[0].market
      );

      // TODO: this only works if there is only one order in the payload
      const orders = await mangoAccount.loadPerpOpenOrdersForMarket(
        this._client,
        this.mangoGroup,
        this.parsedMarkets[perpOrdersToCreate[0].market].perpMarketIndex,
        true
      );

      // Check order in orders if expiryTimestamp is the same as the one in payload
      for (const order of orders) {
        for (const identifier of payload.identifiers) {
          if (order.expiryTimestamp.toString() === identifier.expiryTimestamp) {
            identifiedOrders.push({
              clientOrderId: identifier.clientOrderId.toString(),
              exchangeOrderId: order.orderId.toString(),
            });

            this._orderTracker.updateOrderExchangeOrderId(
              identifier.clientOrderId.toString(),
              order.orderId.toString()
            );

            this._orderTracker.updateOrderStatus(
              identifier.clientOrderId.toString(),
              OrderStatus.OPEN
            );
          }
        }
      }

      return { txHash: txSignature.signature, identifiedOrders };
    }

    const instructions = [
      ...(await this.buildDeleteOrder(
        tempClient,
        walletProvider,
        perpOrdersToCancel
      )),
    ];

    const txSignature = await tempClient.sendAndConfirmTransaction(
      instructions,
      {
        alts: this.mangoGroup.addressLookupTablesList,
        skipPreflight: true,
      }
    );

    for (const order of perpOrdersToCancel) {
      this._orderTracker.updateOrderStatusByExchangeOrderId(
        order.orderId,
        OrderStatus.CANCELLED
      );
    }

    return { txHash: txSignature.signature, identifiedOrders: undefined };
  }
}