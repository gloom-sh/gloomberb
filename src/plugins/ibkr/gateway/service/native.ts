import {
  MarketDataType,
  type Contract,
  type ContractDetails,
  type IBApiNext,
} from "@stoqey/ib";
import type { TimeRange } from "../../../../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../../../../time-series/resolution";
import type { BrokerConnectionStatus, BrokerPosition } from "../../../../types/broker";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { Quote, PricePoint, TickerFinancials } from "../../../../types/financials";
import type { BrokerContractRef, InstrumentSearchResult } from "../../../../types/instrument";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderPreview,
  BrokerOrderRequest,
} from "../../../../types/trading";
import {
  loadIbkrAccounts,
  loadIbkrExecutions,
  loadIbkrOpenOrders,
  loadIbkrPositions,
} from "../account-loaders";
import { IbkrClientLockManager } from "../client-lock";
import { bindIbkrConnectionEvents } from "../connection-events";
import {
  getIbkrHistoryCapabilities,
  IBKR_RESOLUTION_SUPPORT,
} from "../history";
import {
  loadIbkrDetailedPriceHistory,
  loadIbkrPriceHistory,
  loadIbkrPriceHistoryForResolution,
  type IbkrHistoryRequestContext,
} from "../history-requests";
import {
  fetchIbkrFundamentalData,
  loadIbkrTickerFinancials,
} from "../fundamentals";
import {
  getIbkrPrimaryContractDetails,
  resolveIbkrContract,
  searchIbkrInstruments,
  type IbkrInstrumentLookupContext,
} from "../instrument-lookup";
import {
  applyTickByTickAllLastToQuote,
  applyTickByTickBidAskToQuote,
  hasDelayedMarketData,
  marketDataToQuote,
  type TickByTickAllLast,
} from "../market-data";
import {
  cancelNativeIbkrOrder,
  modifyNativeIbkrOrder,
  placeNativeIbkrOrder,
  previewNativeIbkrOrder,
  type IbkrOrderWorkflowContext,
} from "../order-execution";
import {
  type QuoteStreamListener,
} from "../quote-stream";
import { IbkrQuoteStreamController } from "../quote-stream-controller";
import {
  connectIbkrGatewayInternal,
  connectWithClientFallback,
  type ConnectIbkrGatewayInternalContext,
  type ResolvedGatewayListener,
} from "./lifecycle";
import { withIbkrMarketDataFallback } from "./market-data";
import { IbkrGatewayServiceManager } from "./manager";
import { IBKR_DATA_TIMEOUT, withTimeout } from "../timeouts";
import type { IbkrGatewayConfig, IbkrSnapshot, ResolvedIbkrGatewayConnection } from "../types";

export { summarizeBrokerAccount } from "../account-summary";
export { diagnoseLocalIbkrPortIssue, resolveGatewayConnection } from "../connection";
export { parseIbkrHistoricalBarTime } from "../history";
export { applyTickByTickAllLastToQuote, applyTickByTickBidAskToQuote, type TickByTickAllLast } from "../market-data";

const DEFAULT_SNAPSHOT: IbkrSnapshot = {
  status: { state: "disconnected", updatedAt: Date.now() },
  accounts: [],
  openOrders: [],
  executions: [],
};

let resolvedGatewayListener: ResolvedGatewayListener | null = null;

export function setResolvedIbkrGatewayListener(listener: ResolvedGatewayListener | null): void {
  resolvedGatewayListener = listener;
}

export class IbkrGatewayService {
  private api: IBApiNext | null = null;
  private configKey: string | null = null;
  private connecting: Promise<void> | null = null;
  /** Account IDs captured from the managedAccounts event on initial connection. */
  private cachedAccountIds: string[] = [];
  private snapshot: IbkrSnapshot = DEFAULT_SNAPSHOT;
  private listeners = new Set<() => void>();
  private activeMarketDataType: MarketDataType = MarketDataType.REALTIME;
  private autoMarketData = true;
  /** Dedup in-flight requests: reuse pending promises for the same key. */
  private pendingRequests = new Map<string, Promise<any>>();
  private readonly clientLocks: IbkrClientLockManager;
  private connectionNote?: string;
  private resolvedConnection: ResolvedIbkrGatewayConnection | null = null;
  private readonly quoteStreamController: IbkrQuoteStreamController;

  constructor(private readonly instanceId?: string) {
    this.clientLocks = new IbkrClientLockManager(instanceId);
    this.quoteStreamController = new IbkrQuoteStreamController({
      connect: (config) => this.connect(config),
      getApi: () => this.api!,
      getRawApi: () => this.getRawApi(),
      getActiveMarketDataType: () => this.activeMarketDataType,
      resolveContract: (symbol, exchange, instrument) => this.resolveContract(symbol, exchange, instrument),
      getPrimaryContractDetails: (contract) => this.getPrimaryContractDetails(contract),
      withMarketDataFallback: (operation) => this.withMarketDataFallback(operation),
    }, instanceId);
  }

  /** Dedup concurrent calls with the same key — returns cached promise if one is in flight. */
  private dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pendingRequests.get(key);
    if (existing) return existing as Promise<T>;
    const promise = fn().finally(() => this.pendingRequests.delete(key));
    this.pendingRequests.set(key, promise);
    return promise;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): IbkrSnapshot {
    return this.snapshot;
  }

  getStatus(): BrokerConnectionStatus {
    return this.snapshot.status;
  }

  getResolvedConnection(): ResolvedIbkrGatewayConnection | null {
    return this.resolvedConnection;
  }

  async connect(config: IbkrGatewayConfig): Promise<void> {
    const nextKey = JSON.stringify({
      host: config.host,
      port: config.port ?? null,
      clientId: config.clientId ?? null,
      marketDataType: config.marketDataType ?? "auto",
    });
    if (this.api?.isConnected && this.configKey === nextKey) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connectWithClientFallback(config, nextKey);
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    this.quoteStreamController.teardown();
    this.api?.disconnect();
    this.api = null;
    this.configKey = null;
    this.autoMarketData = true;
    this.activeMarketDataType = MarketDataType.REALTIME;
    this.connectionNote = undefined;
    this.resolvedConnection = null;
    await this.clientLocks.release();
    this.updateSnapshot({
      ...this.snapshot,
      status: { state: "disconnected", updatedAt: Date.now() },
      accounts: [],
      openOrders: [],
      executions: [],
    });
  }

  async searchInstruments(query: string, config: IbkrGatewayConfig): Promise<InstrumentSearchResult[]> {
    await this.connect(config);
    return searchIbkrInstruments(this.getInstrumentLookupContext(), query);
  }

  async getAccounts(config: IbkrGatewayConfig): Promise<BrokerAccount[]> {
    await this.connect(config);
    return this.loadAccountsAndUpdateSnapshot();
  }

  async getPositions(config: IbkrGatewayConfig): Promise<BrokerPosition[]> {
    await this.connect(config);
    return loadIbkrPositions({
      api: this.api!,
      instanceId: this.instanceId,
    });
  }

  async getQuote(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange = "",
    instrument?: BrokerContractRef | null,
  ): Promise<Quote> {
    return this.dedup(`quote:${ticker}:${exchange}`, async () => {
      await this.connect(config);
      const contract = await withTimeout(this.resolveContract(ticker, exchange, instrument ?? null), IBKR_DATA_TIMEOUT, "resolveContract");
      const details = await withTimeout(this.getPrimaryContractDetails(contract), IBKR_DATA_TIMEOUT, "getContractDetails");
      const marketData = await this.withMarketDataFallback(
        () => withTimeout(this.api!.getMarketDataSnapshot(contract, "", false), IBKR_DATA_TIMEOUT, "getMarketDataSnapshot"),
      );
      const quote = marketDataToQuote(contract, details, marketData);
      quote.dataSource = hasDelayedMarketData(marketData) || this.activeMarketDataType !== MarketDataType.REALTIME
        ? "delayed"
        : "live";
      return quote;
    });
  }

  subscribeQuotes(
    config: IbkrGatewayConfig,
    targets: QuoteSubscriptionTarget[],
    onQuote: QuoteStreamListener,
  ): () => void {
    return this.quoteStreamController.subscribe(config, targets, onQuote);
  }

  async getTickerFinancials(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange = "",
    instrument?: BrokerContractRef | null,
  ): Promise<TickerFinancials> {
    return this.dedup(`financials:${ticker}:${exchange}`, async () => {
      await this.connect(config);
      return loadIbkrTickerFinancials({
        resolveContract: (symbol, requestExchange, requestInstrument) => this.resolveContract(symbol, requestExchange, requestInstrument),
        getQuote: (symbol, requestExchange, requestInstrument) => this.getQuote(symbol, config, requestExchange, requestInstrument),
        getPriceHistory: (symbol, requestExchange, range, requestInstrument) => (
          this.getPriceHistory(symbol, config, requestExchange, range, requestInstrument)
        ),
        fetchFundamentalData: (contract, reportType) => fetchIbkrFundamentalData(this.api!, contract, reportType),
      }, {
        ticker,
        exchange,
        instrument,
      });
    });
  }

  async getPriceHistory(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    range: TimeRange,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]> {
    return this.dedup(`history:${ticker}:${exchange}:${range}`, async () => {
      await this.connect(config);
      return loadIbkrPriceHistory(this.getHistoryRequestContext(), {
        ticker,
        exchange,
        range,
        instrument,
      });
    });
  }

  getChartResolutionSupport(
    _ticker: string,
    _config: IbkrGatewayConfig,
    _exchange?: string,
    _instrument?: BrokerContractRef | null,
  ): ChartResolutionSupport[] {
    return IBKR_RESOLUTION_SUPPORT;
  }

  getChartResolutionCapabilities(
    _ticker: string,
    _config: IbkrGatewayConfig,
    _exchange?: string,
    _instrument?: BrokerContractRef | null,
  ): ManualChartResolution[] {
    return getIbkrHistoryCapabilities();
  }

  async getPriceHistoryForResolution(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]> {
    return this.dedup(`history:${ticker}:${exchange}:${bufferRange}:${resolution}`, async () => {
      await this.connect(config);
      return loadIbkrPriceHistoryForResolution(this.getHistoryRequestContext(), {
        ticker,
        exchange,
        bufferRange,
        resolution,
        instrument,
      });
    });
  }

  async getDetailedPriceHistory(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]> {
    const key = `detail:${ticker}:${exchange}:${barSize}:${startDate.getTime()}:${endDate.getTime()}`;
    return this.dedup(key, async () => {
      await this.connect(config);
      return loadIbkrDetailedPriceHistory(this.getHistoryRequestContext(), {
        ticker,
        exchange,
        startDate,
        endDate,
        barSize,
        instrument,
      });
    });
  }

  async listOpenOrders(config: IbkrGatewayConfig): Promise<BrokerOrder[]> {
    await this.connect(config);
    return this.loadOpenOrders();
  }

  async listExecutions(config: IbkrGatewayConfig): Promise<BrokerExecution[]> {
    await this.connect(config);
    return this.loadExecutions();
  }

  async previewOrder(config: IbkrGatewayConfig, request: BrokerOrderRequest): Promise<BrokerOrderPreview> {
    return previewNativeIbkrOrder(this.getOrderWorkflowContext(), config, request);
  }

  async placeOrder(config: IbkrGatewayConfig, request: BrokerOrderRequest): Promise<BrokerOrder> {
    return placeNativeIbkrOrder(this.getOrderWorkflowContext(), config, request);
  }

  async modifyOrder(config: IbkrGatewayConfig, orderId: number, request: BrokerOrderRequest): Promise<BrokerOrder> {
    return modifyNativeIbkrOrder(this.getOrderWorkflowContext(), config, orderId, request);
  }

  async cancelOrder(config: IbkrGatewayConfig, orderId: number): Promise<void> {
    return cancelNativeIbkrOrder(this.getOrderWorkflowContext(), config, orderId);
  }

  private async connectWithClientFallback(config: IbkrGatewayConfig, configKey: string): Promise<void> {
    return connectWithClientFallback({
      config,
      configKey,
      clientLocks: this.clientLocks,
      snapshot: this.snapshot,
      updateSnapshot: (snapshot) => this.updateSnapshot(snapshot),
      connectInternal: (resolvedConfig, resolvedConfigKey, connectionNote) => (
        this.connectInternal(resolvedConfig, resolvedConfigKey, connectionNote)
      ),
      disconnect: () => this.disconnect(),
      onResolved: (connection) => {
        this.resolvedConnection = connection;
        void resolvedGatewayListener?.(this.instanceId, connection);
      },
    });
  }

  private async connectInternal(
    config: IbkrGatewayConfig,
    configKey: string,
    connectionNote?: string,
  ): Promise<void> {
    return connectIbkrGatewayInternal(this.getLifecycleContext(), config, configKey, connectionNote);
  }

  private updateSnapshot(snapshot: IbkrSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private bindConnectionEvents(api: IBApiNext): void {
    bindIbkrConnectionEvents({
      api,
      getRawApi: () => this.getRawApi(),
      getSnapshot: () => this.snapshot,
      getConnectionNote: () => this.connectionNote,
      isAutoMarketData: () => this.autoMarketData,
      setCachedAccountIds: (accountIds) => {
        this.cachedAccountIds = accountIds;
      },
      updateSnapshot: (snapshot) => this.updateSnapshot(snapshot),
    });
  }

  private async withMarketDataFallback<T>(operation: () => Promise<T>): Promise<T> {
    return withIbkrMarketDataFallback({
      operation,
      autoMarketData: this.autoMarketData,
      activeMarketDataType: this.activeMarketDataType,
      setDelayedMarketData: () => {
        this.api?.setMarketDataType(MarketDataType.DELAYED);
        this.activeMarketDataType = MarketDataType.DELAYED;
      },
      getSnapshot: () => this.snapshot,
      updateSnapshot: (snapshot) => this.updateSnapshot(snapshot),
    });
  }

  private async loadAccounts(): Promise<BrokerAccount[]> {
    return loadIbkrAccounts({
      api: this.api!,
      rawApi: this.getRawApi(),
      cachedAccountIds: this.cachedAccountIds,
      setCachedAccountIds: (accountIds) => {
        this.cachedAccountIds = accountIds;
      },
      instanceId: this.instanceId,
    });
  }

  private async loadAccountsAndUpdateSnapshot(): Promise<BrokerAccount[]> {
    const accounts = await this.loadAccounts();
    this.updateSnapshot({ ...this.snapshot, accounts });
    return accounts;
  }

  private async loadOpenOrders(): Promise<BrokerOrder[]> {
    const mapped = await loadIbkrOpenOrders({
      api: this.api!,
      instanceId: this.instanceId,
    });
    this.updateSnapshot({ ...this.snapshot, openOrders: mapped });
    return mapped;
  }

  private async loadExecutions(): Promise<BrokerExecution[]> {
    const mapped = await loadIbkrExecutions({
      api: this.api!,
      instanceId: this.instanceId,
    });
    this.updateSnapshot({ ...this.snapshot, executions: mapped });
    return mapped;
  }

  private getHistoryRequestContext(): IbkrHistoryRequestContext {
    return {
      api: this.api!,
      resolveContract: (ticker, exchange, instrument) => this.resolveContract(ticker, exchange, instrument),
      getPrimaryContractDetails: (contract) => this.getPrimaryContractDetails(contract),
      withMarketDataFallback: (operation) => this.withMarketDataFallback(operation),
    };
  }

  private getLifecycleContext(): ConnectIbkrGatewayInternalContext {
    return {
      instanceId: this.instanceId,
      bindConnectionEvents: (api) => this.bindConnectionEvents(api),
      disconnect: () => this.disconnect(),
      getApi: () => this.api,
      getConfigKey: () => this.configKey,
      getRequestedClientId: () => this.clientLocks.activeClaim?.requestedClientId,
      getSnapshot: () => this.snapshot,
      loadInitialSnapshot: async () => {
        await Promise.allSettled([
          this.loadAccountsAndUpdateSnapshot(),
          this.loadOpenOrders(),
          this.loadExecutions(),
        ]);
      },
      setActiveMarketDataType: (marketDataType) => {
        this.activeMarketDataType = marketDataType;
      },
      setApi: (api) => {
        this.api = api;
      },
      setAutoMarketData: (auto) => {
        this.autoMarketData = auto;
      },
      setConfigKey: (configKey) => {
        this.configKey = configKey;
      },
      setConnectionNote: (connectionNote) => {
        this.connectionNote = connectionNote;
      },
      updateSnapshot: (snapshot) => this.updateSnapshot(snapshot),
    };
  }

  private async resolveContract(ticker: string, exchange: string, instrument: BrokerContractRef | null): Promise<Contract> {
    return resolveIbkrContract(this.getInstrumentLookupContext(), ticker, exchange, instrument);
  }

  private async getPrimaryContractDetails(contract: Contract): Promise<ContractDetails> {
    return getIbkrPrimaryContractDetails(this.api!, contract);
  }

  private getInstrumentLookupContext(): IbkrInstrumentLookupContext {
    return {
      api: this.api!,
      instanceId: this.instanceId,
    };
  }

  private getOrderWorkflowContext(): IbkrOrderWorkflowContext {
    return {
      brokerInstanceId: this.instanceId,
      cancelOrder: (orderId) => this.api!.cancelOrder(orderId),
      connect: (config) => this.connect(config),
      getNextValidOrderId: () => this.api!.getNextValidOrderId(),
      getRawApi: () => this.getRawApi(),
      listOpenOrders: (config) => this.listOpenOrders(config),
      resolveContract: (ticker, exchange, instrument) => this.resolveContract(ticker, exchange, instrument),
    };
  }

  private getRawApi(): any {
    return (this.api as any)?.api ?? this.api;
  }
}

export { IbkrGatewayServiceManager } from "./manager";

export const ibkrGatewayManager = new IbkrGatewayServiceManager(
  (instanceId) => new IbkrGatewayService(instanceId),
  DEFAULT_SNAPSHOT,
);
