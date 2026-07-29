import type { TimeRange } from "../time-series/range";
import type { ManualChartResolution } from "../time-series/resolution";
import type { BrokerAdapter, BrokerConnectionStatus } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import type { BrokerContractRef } from "../types/instrument";
import type { BrokerOrderRequest } from "../types/trading";

export interface BrokerRemoteClient {
  invoke<T = unknown>(instanceId: string, operation: string, args?: unknown[]): Promise<T>;
  getStatus(instanceId: string): BrokerConnectionStatus | null;
  subscribeStatus(instanceId: string, listener: () => void): () => void;
  subscribeQuotes(
    instanceId: string,
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: any) => void,
  ): () => void;
  removeInstance(instanceId: string): Promise<void>;
  destroyAll(): Promise<void>;
}

let brokerRemoteClient: BrokerRemoteClient | null = null;

export function setBrokerRemoteClient(client: BrokerRemoteClient | null): void {
  brokerRemoteClient = client;
}

export function getBrokerRemoteClient(): BrokerRemoteClient | null {
  return brokerRemoteClient;
}

function disconnectedStatus(): BrokerConnectionStatus {
  return { state: "disconnected", updatedAt: 0 };
}

export function createRemoteBrokerAdapter(adapter: BrokerAdapter): BrokerAdapter {
  const invoke = <T,>(instance: BrokerInstanceConfig, operation: string, args: unknown[] = []) => {
    const client = getBrokerRemoteClient();
    if (!client) throw new Error("Broker remote host is not available.");
    return client.invoke<T>(instance.id, operation, args);
  };

  return {
    ...adapter,
    validate: (instance) => invoke<boolean>(instance, "validate"),
    importPositions: (instance) => invoke(instance, "importPositions"),
    importPortfolioSnapshot: adapter.importPortfolioSnapshot
      ? (instance) => invoke(instance, "importPortfolioSnapshot")
      : undefined,
    connect: (instance) => invoke<void>(instance, "connect"),
    disconnect: (instance) => invoke<void>(instance, "disconnect"),
    getStatus: (instance) => getBrokerRemoteClient()?.getStatus(instance.id) ?? adapter.getStatus?.(instance) ?? disconnectedStatus(),
    subscribeStatus: (instance, listener) => getBrokerRemoteClient()?.subscribeStatus(instance.id, listener) ?? (() => {}),
    getPersistedConfigUpdate: (instance) => invoke<Record<string, unknown> | null>(instance, "getPersistedConfigUpdate"),
    listAccounts: (instance) => invoke(instance, "listAccounts"),
    getPortfolioPerformance: (instance, accountId: string) => invoke(instance, "getPortfolioPerformance", [accountId]),
    searchInstruments: (query, instance) => invoke(instance, "searchInstruments", [query]),
    getTickerFinancials: (ticker, instance, exchange?: string, instrument?: BrokerContractRef | null) =>
      invoke(instance, "getTickerFinancials", [ticker, exchange, instrument]),
    getQuote: (ticker, instance, exchange?: string, instrument?: BrokerContractRef | null) =>
      invoke(instance, "getQuote", [ticker, exchange, instrument]),
    getPriceHistory: (ticker, instance, exchange: string, range: TimeRange, instrument?: BrokerContractRef | null) =>
      invoke(instance, "getPriceHistory", [ticker, exchange, range, instrument]),
    getPriceHistoryForResolution: (
      ticker,
      instance,
      exchange: string,
      bufferRange: TimeRange,
      resolution: ManualChartResolution,
      instrument?: BrokerContractRef | null,
    ) => invoke(instance, "getPriceHistoryForResolution", [ticker, exchange, bufferRange, resolution, instrument]),
    getDetailedPriceHistory: (
      ticker,
      instance,
      exchange: string,
      startDate: Date,
      endDate: Date,
      barSize: string,
      instrument?: BrokerContractRef | null,
    ) => invoke(instance, "getDetailedPriceHistory", [ticker, exchange, startDate, endDate, barSize, instrument]),
    getChartResolutionSupport: (ticker, instance, exchange?: string, instrument?: BrokerContractRef | null) =>
      invoke(instance, "getChartResolutionSupport", [ticker, exchange, instrument]),
    getChartResolutionCapabilities: (ticker, instance, exchange?: string, instrument?: BrokerContractRef | null) =>
      invoke(instance, "getChartResolutionCapabilities", [ticker, exchange, instrument]),
    getOptionsChain: (ticker, instance, exchange?: string, expirationDate?: number, instrument?: BrokerContractRef | null) =>
      invoke(instance, "getOptionsChain", [ticker, exchange, expirationDate, instrument]),
    subscribeQuotes: (instance, targets, onQuote) => getBrokerRemoteClient()?.subscribeQuotes(instance.id, targets, onQuote) ?? (() => {}),
    listOpenOrders: (instance) => invoke(instance, "listOpenOrders"),
    listExecutions: (instance) => invoke(instance, "listExecutions"),
    previewOrder: (instance, request: BrokerOrderRequest) => invoke(instance, "previewOrder", [request]),
    placeOrder: (instance, request: BrokerOrderRequest) => invoke(instance, "placeOrder", [request]),
    modifyOrder: (instance, orderId: number, request: BrokerOrderRequest) => invoke(instance, "modifyOrder", [orderId, request]),
    cancelOrder: (instance, orderId: number) => invoke<void>(instance, "cancelOrder", [orderId]),
  };
}
