import type { TimeRange } from "../../../../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../../../../time-series/resolution";
import { getBrokerRemoteClient } from "../../../../brokers/remote-broker-adapter";
import type { BrokerPosition } from "../../../../types/broker";
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
import type {
  IbkrGatewayConfig,
  IbkrSnapshot,
  ResolvedIbkrGatewayConnection,
} from "../types";
import {
  loadNativeGatewayModule as loadDefaultNativeGatewayModule,
  type NativeGatewayModule,
} from "./native-loader";

export type { IbkrGatewayServiceFacade };
export type {
  IbkrGatewayConfig,
  ResolvedIbkrGatewayConnection,
} from "../types";

type NativeGatewayManager = any;
type NativeGatewayService = any;
type Listener = () => void;
type ResolvedGatewayListener = (
  instanceId: string | undefined,
  connection: ResolvedIbkrGatewayConnection,
) => void | Promise<void>;

const DEFAULT_SNAPSHOT: IbkrSnapshot = {
  status: { state: "disconnected", updatedAt: Date.now() },
  accounts: [],
  openOrders: [],
  executions: [],
};

let resolvedGatewayListener: ResolvedGatewayListener | null = null;
let loadedNativeGatewayModule: NativeGatewayModule | null = null;
let nativeGatewayModulePromise: Promise<NativeGatewayModule> | null = null;
let nativeGatewayManager: NativeGatewayManager | null = null;
let nativeGatewayModuleLoader: () => Promise<NativeGatewayModule>;

const snapshots = new Map<string, IbkrSnapshot>();
const listeners = new Map<string, Set<Listener>>();

function getSnapshotEntry(instanceId?: string): IbkrSnapshot {
  if (!instanceId) return DEFAULT_SNAPSHOT;
  return snapshots.get(instanceId) ?? DEFAULT_SNAPSHOT;
}

function defaultNativeGatewayModuleLoader(): Promise<NativeGatewayModule> {
  return loadDefaultNativeGatewayModule();
}

nativeGatewayModuleLoader = defaultNativeGatewayModuleLoader;

export function setNativeIbkrGatewayModuleLoader(loader: (() => Promise<NativeGatewayModule>) | null): void {
  nativeGatewayModuleLoader = loader ?? defaultNativeGatewayModuleLoader;
}

function applySnapshot(instanceId: string, patch: Partial<IbkrSnapshot>, shouldNotify: boolean): IbkrSnapshot {
  const current = getSnapshotEntry(instanceId);
  const next = {
    ...current,
    ...patch,
    status: patch.status ?? current.status,
    accounts: patch.accounts ?? current.accounts,
    openOrders: patch.openOrders ?? current.openOrders,
    executions: patch.executions ?? current.executions,
  };
  if (
    next.status === current.status
    && next.accounts === current.accounts
    && next.openOrders === current.openOrders
    && next.executions === current.executions
  ) {
    return current;
  }
  snapshots.set(instanceId, next);
  if (shouldNotify) notify(instanceId);
  return next;
}

function updateSnapshot(instanceId: string, patch: Partial<IbkrSnapshot>): void {
  applySnapshot(instanceId, patch, true);
}

function cacheSnapshot(instanceId: string, patch: Partial<IbkrSnapshot>): IbkrSnapshot {
  return applySnapshot(instanceId, patch, false);
}

function notify(instanceId: string): void {
  for (const listener of listeners.get(instanceId) ?? []) {
    listener();
  }
}

async function loadNativeGatewayModule(): Promise<NativeGatewayModule> {
  if (!nativeGatewayModulePromise) {
    nativeGatewayModulePromise = nativeGatewayModuleLoader().catch((error) => {
      nativeGatewayModulePromise = null;
      throw error;
    });
  }
  const module = await nativeGatewayModulePromise;
  loadedNativeGatewayModule = module;
  nativeGatewayManager = module.ibkrGatewayManager;
  module.setResolvedIbkrGatewayListener(resolvedGatewayListener);
  return module;
}

async function getNativeService(instanceId: string): Promise<NativeGatewayService> {
  const module = await loadNativeGatewayModule();
  return module.ibkrGatewayManager.getService(instanceId);
}

export function setResolvedIbkrGatewayListener(listener: ResolvedGatewayListener | null): void {
  resolvedGatewayListener = listener;
  if (getBrokerRemoteClient()) return;
  if (loadedNativeGatewayModule) {
    loadedNativeGatewayModule.setResolvedIbkrGatewayListener(listener);
    return;
  }
  if (!nativeGatewayModulePromise) {
    return;
  }
  void nativeGatewayModulePromise.then((module) => {
    module.setResolvedIbkrGatewayListener(listener);
  }).catch(() => {});
}

class IbkrGatewayServiceFacade {
  constructor(private readonly instanceId: string) {}

  getSnapshot(): IbkrSnapshot {
    const remoteStatus = getBrokerRemoteClient()?.getStatus(this.instanceId);
    if (remoteStatus) {
      return cacheSnapshot(this.instanceId, { status: remoteStatus });
    }
    if (nativeGatewayManager) {
      return nativeGatewayManager.getService(this.instanceId).getSnapshot();
    }
    return getSnapshotEntry(this.instanceId);
  }

  getResolvedConnection(): ResolvedIbkrGatewayConnection | null {
    if (nativeGatewayManager) {
      return nativeGatewayManager.getService(this.instanceId).getResolvedConnection();
    }
    return null;
  }

  subscribe(listener: Listener): () => void {
    if (!listeners.has(this.instanceId)) listeners.set(this.instanceId, new Set());
    listeners.get(this.instanceId)!.add(listener);

    const remoteDispose = getBrokerRemoteClient()?.subscribeStatus(this.instanceId, () => {
      const status = getBrokerRemoteClient()?.getStatus(this.instanceId);
      if (status) {
        updateSnapshot(this.instanceId, { status });
      } else {
        listener();
      }
    });

    if (remoteDispose) {
      return () => {
        remoteDispose();
        listeners.get(this.instanceId)?.delete(listener);
      };
    }

    let nativeDispose: (() => void) | null = null;
    if (nativeGatewayManager) {
      const service = nativeGatewayManager.getService(this.instanceId);
      nativeDispose = service.subscribe(() => {
        updateSnapshot(this.instanceId, service.getSnapshot());
      });
    }
    listener();

    return () => {
      nativeDispose?.();
      listeners.get(this.instanceId)?.delete(listener);
    };
  }

  async connect(config: IbkrGatewayConfig): Promise<void> {
    const remote = getBrokerRemoteClient();
    if (remote) {
      await remote.invoke<void>(this.instanceId, "connect");
      return;
    }
    const service = await getNativeService(this.instanceId);
    await service.connect(config);
    updateSnapshot(this.instanceId, service.getSnapshot());
  }

  async disconnect(): Promise<void> {
    const remote = getBrokerRemoteClient();
    if (remote) return remote.invoke<void>(this.instanceId, "disconnect");
    const service = await getNativeService(this.instanceId);
    await service.disconnect();
    updateSnapshot(this.instanceId, service.getSnapshot());
  }

  async getAccounts(config: IbkrGatewayConfig): Promise<BrokerAccount[]> {
    const remote = getBrokerRemoteClient();
    const accounts = remote
      ? await remote.invoke<BrokerAccount[]>(this.instanceId, "listAccounts")
      : await (await getNativeService(this.instanceId)).getAccounts(config);
    updateSnapshot(this.instanceId, { accounts });
    return accounts;
  }

  async getPositions(config: IbkrGatewayConfig): Promise<BrokerPosition[]> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "importPositions")
      : (await getNativeService(this.instanceId)).getPositions(config);
  }

  async listOpenOrders(config: IbkrGatewayConfig): Promise<BrokerOrder[]> {
    const remote = getBrokerRemoteClient();
    const openOrders = remote
      ? await remote.invoke<BrokerOrder[]>(this.instanceId, "listOpenOrders")
      : await (await getNativeService(this.instanceId)).listOpenOrders(config);
    updateSnapshot(this.instanceId, { openOrders });
    return openOrders;
  }

  async listExecutions(config: IbkrGatewayConfig): Promise<BrokerExecution[]> {
    const remote = getBrokerRemoteClient();
    const executions = remote
      ? await remote.invoke<BrokerExecution[]>(this.instanceId, "listExecutions")
      : await (await getNativeService(this.instanceId)).listExecutions(config);
    updateSnapshot(this.instanceId, { executions });
    return executions;
  }

  async searchInstruments(query: string, config: IbkrGatewayConfig): Promise<InstrumentSearchResult[]> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "searchInstruments", [query])
      : (await getNativeService(this.instanceId)).searchInstruments(query, config);
  }

  async getTickerFinancials(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange = "",
    instrument?: BrokerContractRef | null,
  ): Promise<TickerFinancials> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "getTickerFinancials", [ticker, exchange, instrument])
      : (await getNativeService(this.instanceId)).getTickerFinancials(ticker, config, exchange, instrument);
  }

  async getQuote(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange = "",
    instrument?: BrokerContractRef | null,
  ): Promise<Quote> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "getQuote", [ticker, exchange, instrument])
      : (await getNativeService(this.instanceId)).getQuote(ticker, config, exchange, instrument);
  }

  async getPriceHistory(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    range: TimeRange,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "getPriceHistory", [ticker, exchange, range, instrument])
      : (await getNativeService(this.instanceId)).getPriceHistory(ticker, config, exchange, range, instrument);
  }

  getChartResolutionSupport(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange = "",
    instrument?: BrokerContractRef | null,
  ): Promise<ChartResolutionSupport[]> | ChartResolutionSupport[] {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "getChartResolutionSupport", [ticker, exchange, instrument])
      : getNativeService(this.instanceId).then((service) => service.getChartResolutionSupport(ticker, config, exchange, instrument));
  }

  async getPriceHistoryForResolution(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "getPriceHistoryForResolution", [ticker, exchange, bufferRange, resolution, instrument])
      : (await getNativeService(this.instanceId)).getPriceHistoryForResolution(ticker, config, exchange, bufferRange, resolution, instrument);
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
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "getDetailedPriceHistory", [ticker, exchange, startDate, endDate, barSize, instrument])
      : (await getNativeService(this.instanceId)).getDetailedPriceHistory(ticker, config, exchange, startDate, endDate, barSize, instrument);
  }

  subscribeQuotes(
    config: IbkrGatewayConfig,
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void {
    const remote = getBrokerRemoteClient();
    if (remote) return remote.subscribeQuotes(this.instanceId, targets, onQuote);

    let nativeDispose: (() => void) | null = null;
    let disposed = false;
    void getNativeService(this.instanceId).then((service) => {
      if (disposed) return;
      nativeDispose = service.subscribeQuotes(config, targets, onQuote);
    }).catch(() => {});
    return () => {
      disposed = true;
      nativeDispose?.();
    };
  }

  async previewOrder(config: IbkrGatewayConfig, request: BrokerOrderRequest): Promise<BrokerOrderPreview> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "previewOrder", [request])
      : (await getNativeService(this.instanceId)).previewOrder(config, request);
  }

  async placeOrder(config: IbkrGatewayConfig, request: BrokerOrderRequest): Promise<BrokerOrder> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "placeOrder", [request])
      : (await getNativeService(this.instanceId)).placeOrder(config, request);
  }

  async modifyOrder(config: IbkrGatewayConfig, orderId: number, request: BrokerOrderRequest): Promise<BrokerOrder> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "modifyOrder", [orderId, request])
      : (await getNativeService(this.instanceId)).modifyOrder(config, orderId, request);
  }

  async cancelOrder(config: IbkrGatewayConfig, orderId: number): Promise<void> {
    const remote = getBrokerRemoteClient();
    return remote
      ? remote.invoke(this.instanceId, "cancelOrder", [orderId])
      : (await getNativeService(this.instanceId)).cancelOrder(config, orderId);
  }
}

class IbkrGatewayServiceManager {
  private services = new Map<string, IbkrGatewayServiceFacade>();

  getService(instanceId: string): IbkrGatewayServiceFacade {
    let service = this.services.get(instanceId);
    if (!service) {
      service = new IbkrGatewayServiceFacade(instanceId);
      this.services.set(instanceId, service);
    }
    return service;
  }

  getSnapshot(instanceId?: string): IbkrSnapshot {
    if (!instanceId) return DEFAULT_SNAPSHOT;
    return this.getService(instanceId).getSnapshot();
  }

  subscribe(instanceId: string | undefined, listener: Listener): () => void {
    if (!instanceId) return () => {};
    return this.getService(instanceId).subscribe(listener);
  }

  async removeInstance(instanceId: string): Promise<void> {
    const remote = getBrokerRemoteClient();
    if (remote) {
      await remote.removeInstance(instanceId);
    } else if (nativeGatewayManager) {
      await nativeGatewayManager.removeInstance(instanceId);
    }
    this.services.delete(instanceId);
    snapshots.delete(instanceId);
    notify(instanceId);
  }

  async destroyAll(): Promise<void> {
    const remote = getBrokerRemoteClient();
    if (remote) {
      await remote.destroyAll();
    } else if (nativeGatewayManager) {
      await nativeGatewayManager.destroyAll();
    }
    this.services.clear();
    snapshots.clear();
  }
}

export const ibkrGatewayManager = new IbkrGatewayServiceManager();
