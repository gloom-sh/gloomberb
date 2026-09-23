import { afterEach, describe, expect, test } from "bun:test";
import type { BrokerAdapter, BrokerConnectionStatus } from "../../types/broker";
import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";
import { AssetDataRouter } from "./index";
import {
  attachTestRegistry,
  brokerInstance,
  cleanupProviderRouterTestFiles,
  fallbackProvider,
  makeQuote,
  setBrokerInstances,
} from "./test-support";

afterEach(() => {
  cleanupProviderRouterTestFiles();
});

const flushReroute = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const context = (overrides: Partial<NonNullable<QuoteSubscriptionTarget["context"]>["instrument"]> = {}) => ({
  brokerId: "ibkr",
  brokerInstanceId: "ibkr-work",
  instrument: { brokerId: "ibkr", brokerInstanceId: "ibkr-work", symbol: "AAPL", secType: "STK", currency: "USD", ...overrides },
});

const aapl: QuoteSubscriptionTarget = {
  symbol: "AAPL",
  exchange: "NASDAQ",
  route: "broker",
  context: context({ conId: 265598, primaryExchange: "NASDAQ" }),
};
const sap: QuoteSubscriptionTarget = {
  symbol: "SAP",
  exchange: "IBIS",
  route: "broker",
  context: context({ conId: 14204, symbol: "SAP", currency: "EUR", primaryExchange: "IBIS" }),
};

interface StreamLog {
  opened: string[][];
  closed: string[][];
}

function streamLog(): StreamLog {
  return { opened: [], closed: [] };
}

function openSymbols(log: StreamLog): string[] {
  const counts = new Map<string, number>();
  for (const symbols of log.opened) for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  for (const symbols of log.closed) for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) - 1);
  return [...counts].filter(([, count]) => count > 0).map(([symbol]) => symbol).sort();
}

function createCloud(log: StreamLog): DataProvider {
  return {
    ...fallbackProvider,
    id: "cloud",
    name: "Cloud",
    subscribeQuotes(targets) {
      const symbols = targets.map((target) => target.symbol);
      log.opened.push(symbols);
      return () => { log.closed.push(symbols); };
    },
  };
}

function createGateway(log: StreamLog, initial: BrokerConnectionStatus) {
  let status = initial;
  const listeners = new Set<() => void>();
  const emitters: Array<(target: QuoteSubscriptionTarget, dataSource: "live" | "delayed") => void> = [];
  let connectCalls = 0;
  const setStatus = (next: Partial<BrokerConnectionStatus>) => {
    status = { ...status, ...next, updatedAt: status.updatedAt + 1 };
    for (const listener of listeners) listener();
  };
  const broker: BrokerAdapter = {
    id: "ibkr",
    name: "IBKR",
    configSchema: [],
    validate: async () => true,
    importPositions: async () => [],
    getStatus: () => status,
    subscribeStatus(_instance, listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async connect() {
      connectCalls += 1;
      setStatus({ state: "connected" });
    },
    subscribeQuotes(_instance, targets, onQuote) {
      const symbols = targets.map((target) => target.symbol);
      log.opened.push(symbols);
      emitters.push((target, dataSource) => onQuote(target, makeQuote({ symbol: target.symbol, dataSource })));
      return () => { log.closed.push(symbols); };
    },
  };
  return {
    broker,
    setStatus,
    emit(target: QuoteSubscriptionTarget, dataSource: "live" | "delayed") {
      emitters.at(-1)?.(target, dataSource);
    },
    listenerCount: () => listeners.size,
    connectCalls: () => connectCalls,
  };
}

function createRouter(broker: BrokerAdapter, cloudLog: StreamLog, pro: boolean) {
  const router = new AssetDataRouter(fallbackProvider, [createCloud(cloudLog)]);
  attachTestRegistry(router, { brokers: [["ibkr", broker]] });
  setBrokerInstances(router, [brokerInstance()]);
  router.setRealtimeCloudAccess({ has: () => pro });
  return router;
}

describe("broker quote routing", () => {
  test("streams statement-only broker rows from the cloud", () => {
    const cloud = streamLog();
    let brokerCalls = 0;
    const flex: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      validate: async () => true,
      importPositions: async () => [],
      canStreamQuotes: () => false,
      getStatus: () => ({ state: "disconnected", mode: "flex", updatedAt: 0 }),
      subscribeQuotes() {
        brokerCalls += 1;
        return () => {};
      },
    };
    const unsubscribe = createRouter(flex, cloud, false).subscribeQuotes([aapl, sap], () => {});

    expect(brokerCalls).toBe(0);
    expect(openSymbols(cloud)).toEqual(["AAPL", "SAP"]);
    unsubscribe();
    expect(openSymbols(cloud)).toEqual([]);
  });

  test("moves rows between the cloud and a gateway as it connects and disconnects", async () => {
    const cloud = streamLog();
    const brokerLog = streamLog();
    const gateway = createGateway(brokerLog, { state: "connecting", mode: "gateway", updatedAt: 1 });
    const unsubscribe = createRouter(gateway.broker, cloud, true).subscribeQuotes([aapl, sap], () => {});
    expect(openSymbols(cloud)).toEqual(["AAPL", "SAP"]);
    expect(brokerLog.opened).toEqual([]);

    gateway.setStatus({ state: "connected" });
    await flushReroute();
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);
    expect(openSymbols(cloud)).toEqual([]);

    // Status rewrites that do not change eligibility must not restart streams.
    gateway.setStatus({ message: "Market data farm connection is OK" });
    await flushReroute();
    expect(brokerLog.opened).toHaveLength(1);

    gateway.setStatus({ state: "disconnected" });
    await flushReroute();
    expect(openSymbols(brokerLog)).toEqual([]);
    expect(openSymbols(cloud)).toEqual(["AAPL", "SAP"]);

    unsubscribe();
    expect(gateway.listenerCount()).toBe(0);
    expect(openSymbols(cloud)).toEqual([]);
  });

  test("asks a gateway that is down to connect, at most once per interval", async () => {
    const cloud = streamLog();
    const brokerLog = streamLog();
    const gateway = createGateway(brokerLog, { state: "error", mode: "gateway", updatedAt: 1 });
    const router = createRouter(gateway.broker, cloud, true);
    const first = router.subscribeQuotes([aapl, sap], () => {});
    expect(openSymbols(cloud)).toEqual(["AAPL", "SAP"]);

    // Its status moves the rows over once it connects.
    await flushReroute();
    expect(gateway.connectCalls()).toBe(1);
    await flushReroute();
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);
    expect(openSymbols(cloud)).toEqual([]);

    gateway.setStatus({ state: "disconnected" });
    await flushReroute();
    const second = router.subscribeQuotes([aapl, sap], () => {});
    first();
    await flushReroute();
    expect(gateway.connectCalls()).toBe(1);
    second();
  });

  test("a delayed session hands real-time cloud instruments to the cloud and keeps the rest", async () => {
    const cloud = streamLog();
    const brokerLog = streamLog();
    const gateway = createGateway(brokerLog, { state: "connected", mode: "gateway", updatedAt: 1 });
    const seen: string[] = [];
    const router = createRouter(gateway.broker, cloud, true);
    const unsubscribe = router.subscribeQuotes([aapl, sap], (target, quote) => seen.push(`${target.symbol}:${quote.dataSource}`));
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);
    expect(openSymbols(cloud)).toEqual([]);

    // A listing only the broker streams says nothing about the session.
    gateway.emit(sap, "delayed");
    await flushReroute();
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);

    gateway.emit(aapl, "delayed");
    await flushReroute();
    expect(openSymbols(cloud)).toEqual(["AAPL"]);
    expect(openSymbols(brokerLog)).toEqual(["SAP"]);
    // The replacement opened before the old stream closed, so SAP never lost its listener.
    expect(brokerLog.opened.at(-1)).toEqual(["SAP"]);
    expect(seen).toEqual(["SAP:delayed", "AAPL:delayed"]);

    // A reconnect resets the session to real time, even when it completes
    // before the coalesced reroute runs.
    gateway.setStatus({ state: "connecting" });
    gateway.setStatus({ state: "connected" });
    await flushReroute();
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);
    expect(openSymbols(cloud)).toEqual([]);

    // Once nothing watches the profile, the next subscription tries it again.
    gateway.emit(aapl, "delayed");
    await flushReroute();
    expect(openSymbols(cloud)).toEqual(["AAPL"]);
    unsubscribe();
    const again = router.subscribeQuotes([aapl, sap], () => {});
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);
    again();
  });

  test("a delayed session keeps every row when the cloud is not real time for the account", async () => {
    const cloud = streamLog();
    const brokerLog = streamLog();
    const gateway = createGateway(brokerLog, { state: "connected", mode: "gateway", quoteData: "delayed", updatedAt: 1 });
    const unsubscribe = createRouter(gateway.broker, cloud, false).subscribeQuotes([aapl, sap], () => {});
    gateway.emit(aapl, "delayed");
    await flushReroute();
    expect(openSymbols(brokerLog)).toEqual(["AAPL", "SAP"]);
    expect(openSymbols(cloud)).toEqual([]);
    unsubscribe();

    const proCloud = streamLog();
    const proBroker = streamLog();
    const reported = createGateway(proBroker, { state: "connected", mode: "gateway", quoteData: "delayed", updatedAt: 1 });
    const disposePro = createRouter(reported.broker, proCloud, true).subscribeQuotes([aapl, sap], () => {});
    expect(openSymbols(proCloud)).toEqual(["AAPL"]);
    expect(openSymbols(proBroker)).toEqual(["SAP"]);
    disposePro();
  });
});
