import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BarSizeSetting, ConnectionState, SecType, type ContractDetails } from "@stoqey/ib";
import { Subject, of } from "rxjs";
import {
  setBrokerRemoteClient,
  type BrokerRemoteClient,
} from "../../../../brokers/remote-broker-adapter";
import type { BrokerConnectionStatus } from "../../../../types/broker";
import {
  ibkrGatewayManager,
  setNativeIbkrGatewayModuleLoader,
} from "./index";
import {
  applyTickByTickAllLastToQuote,
  applyTickByTickBidAskToQuote,
  diagnoseLocalIbkrPortIssue,
  IbkrGatewayServiceManager,
  IbkrGatewayService,
  parseIbkrHistoricalBarTime,
  resolveGatewayConnection,
  summarizeBrokerAccount,
  type TickByTickAllLast,
} from "./native";

function makeTags(input: Record<string, Record<string, string>>) {
  return new Map(
    Object.entries(input).map(([tag, values]) => [
      tag,
      new Map(Object.entries(values).map(([currency, value]) => [currency, { value }])),
    ]),
  );
}

describe("summarizeBrokerAccount", () => {
  test("maps gateway account summary fields and ledger balances", () => {
    const tags = makeTags({
      NetLiquidation: { USD: "764713.62" },
      GrossPositionValue: { USD: "1815667.34" },
      TotalCashValue: { USD: "-1050953.72" },
      SettledCash: { USD: "-917604.44" },
      AvailableFunds: { USD: "112345.67" },
      BuyingPower: { USD: "224691.34" },
      ExcessLiquidity: { USD: "98321.12" },
      InitMarginReq: { USD: "45678.9" },
      MaintMarginReq: { USD: "34567.8" },
      "$LEDGER:ALL": { USD: "-303029.14", EUR: "-351957.02" },
    });

    expect(summarizeBrokerAccount("DU12345", tags, 1_717_000_000_000)).toEqual({
      accountId: "DU12345",
      name: "DU12345",
      currency: "USD",
      source: "gateway",
      updatedAt: 1_717_000_000_000,
      netLiquidation: 764713.62,
      grossPositionValue: 1815667.34,
      totalCashValue: -1050953.72,
      settledCash: -917604.44,
      availableFunds: 112345.67,
      buyingPower: 224691.34,
      excessLiquidity: 98321.12,
      initMarginReq: 45678.9,
      maintMarginReq: 34567.8,
      dailyPnl: undefined,
      unrealizedPnl: undefined,
      realizedPnl: undefined,
      cashBalances: [
        { currency: "USD", quantity: -303029.14, baseValue: -303029.14, baseCurrency: "USD" },
        { currency: "EUR", quantity: -351957.02, baseValue: undefined, baseCurrency: "USD" },
      ],
    });
  });

  test("falls back to the aggregate cash summary for single-account gateways", () => {
    const accountTags = makeTags({
      NetLiquidation: { USD: "129360.15" },
      GrossPositionValue: { USD: "1066.36" },
      TotalCashValue: { USD: "128293.79" },
      AvailableFunds: { USD: "129031.52" },
      BuyingPower: { USD: "860210.13" },
      ExcessLiquidity: { USD: "129061.51" },
      InitMarginReq: { USD: "328.63" },
      MaintMarginReq: { USD: "298.64" },
    });
    const aggregateTags = makeTags({
      CashBalance: {
        HKD: "1012836.31",
        USD: "-1020.86",
        BASE: "128293.7944",
      },
      ExchangeRate: {
        HKD: "0.1276758",
        USD: "1.00",
        BASE: "1.00",
      },
    });

    expect(summarizeBrokerAccount("DU12345", accountTags, 1_717_000_000_000, aggregateTags, true)).toEqual({
      accountId: "DU12345",
      name: "DU12345",
      currency: "USD",
      source: "gateway",
      updatedAt: 1_717_000_000_000,
      netLiquidation: 129360.15,
      grossPositionValue: 1066.36,
      totalCashValue: 128293.79,
      settledCash: undefined,
      availableFunds: 129031.52,
      buyingPower: 860210.13,
      excessLiquidity: 129061.51,
      initMarginReq: 328.63,
      maintMarginReq: 298.64,
      dailyPnl: undefined,
      unrealizedPnl: undefined,
      realizedPnl: undefined,
      cashBalances: [
        { currency: "HKD", quantity: 1012836.31, baseValue: 129314.68614829802, baseCurrency: "USD" },
        { currency: "USD", quantity: -1020.86, baseValue: -1020.86, baseCurrency: "USD" },
      ],
    });
  });

  test("falls back to aggregate summary metrics when a single-account gateway only returns the All row", () => {
    const aggregateTags = makeTags({
      NetLiquidation: { USD: "129360.15" },
      GrossPositionValue: { USD: "1066.36" },
      TotalCashValue: { USD: "128293.79" },
      AvailableFunds: { USD: "129031.52" },
      BuyingPower: { USD: "860210.13" },
      ExcessLiquidity: { USD: "129061.51" },
      InitMarginReq: { USD: "328.63" },
      MaintMarginReq: { USD: "298.64" },
      CashBalance: {
        HKD: "1012836.31",
        USD: "-1020.86",
        BASE: "128293.7944",
      },
      ExchangeRate: {
        HKD: "0.1276758",
        USD: "1.00",
        BASE: "1.00",
      },
    });

    expect(summarizeBrokerAccount("DU12345", undefined, 1_717_000_000_000, aggregateTags, true)).toEqual({
      accountId: "DU12345",
      name: "DU12345",
      currency: "USD",
      source: "gateway",
      updatedAt: 1_717_000_000_000,
      netLiquidation: 129360.15,
      grossPositionValue: 1066.36,
      totalCashValue: 128293.79,
      settledCash: undefined,
      availableFunds: 129031.52,
      buyingPower: 860210.13,
      excessLiquidity: 129061.51,
      initMarginReq: 328.63,
      maintMarginReq: 298.64,
      dailyPnl: undefined,
      unrealizedPnl: undefined,
      realizedPnl: undefined,
      cashBalances: [
        { currency: "HKD", quantity: 1012836.31, baseValue: 129314.68614829802, baseCurrency: "USD" },
        { currency: "USD", quantity: -1020.86, baseValue: -1020.86, baseCurrency: "USD" },
      ],
    });
  });

  test("maps account-level P&L into gateway account snapshots", () => {
    const tags = makeTags({
      NetLiquidation: { USD: "100000" },
      GrossPositionValue: { USD: "75000" },
    });

    expect(summarizeBrokerAccount("DU12345", tags, 1_717_000_000_000, undefined, false, {
      dailyPnl: 1200.5,
      unrealizedPnl: 5000,
      realizedPnl: -250,
    })).toMatchObject({
      accountId: "DU12345",
      dailyPnl: 1200.5,
      unrealizedPnl: 5000,
      realizedPnl: -250,
    });
  });

  test("returns a minimal account when summary tags are missing", () => {
    expect(summarizeBrokerAccount("DU12345", undefined, 123)).toEqual({
      accountId: "DU12345",
      name: "DU12345",
      currency: undefined,
      source: "gateway",
      updatedAt: 123,
      netLiquidation: undefined,
      grossPositionValue: undefined,
      totalCashValue: undefined,
      settledCash: undefined,
      availableFunds: undefined,
      buyingPower: undefined,
      excessLiquidity: undefined,
      initMarginReq: undefined,
      maintMarginReq: undefined,
      dailyPnl: undefined,
      unrealizedPnl: undefined,
      realizedPnl: undefined,
      cashBalances: undefined,
    });
  });
});

test("remote gateway snapshots are side-effect-free", async () => {
  const instanceId = "ibkr-gateway-snapshot-test";
  const status: BrokerConnectionStatus = {
    state: "connected",
    updatedAt: 123,
  };
  const client: BrokerRemoteClient = {
    invoke: async <T,>() => null as T,
    getStatus: () => status,
    subscribeStatus: () => () => {},
    subscribeQuotes: () => () => {},
    removeInstance: async () => {},
    destroyAll: async () => {},
  };

  setBrokerRemoteClient(client);
  let unsubscribe: (() => void) | null = null;
  try {
    let notifications = 0;
    unsubscribe = ibkrGatewayManager.subscribe(instanceId, () => {
      notifications += 1;
    });

    const first = ibkrGatewayManager.getSnapshot(instanceId);
    const second = ibkrGatewayManager.getSnapshot(instanceId);

    expect(first).toBe(second);
    expect(first.status).toBe(status);
    expect(notifications).toBe(0);
  } finally {
    unsubscribe?.();
    setBrokerRemoteClient(null);
    setNativeIbkrGatewayModuleLoader(null);
    await ibkrGatewayManager.removeInstance(instanceId);
  }
});

test("native gateway loader bundles without a runtime ./native specifier", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "gloomberb-ibkr-service-"));
  try {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.ts")],
      outdir,
      target: "bun",
    });

    expect(result.success).toBe(true);
    const entry = readFileSync(join(outdir, "index.js"), "utf8");
    expect(entry).toContain("src/plugins/ibkr/gateway/service/native.ts");
    expect(entry).not.toContain('"./native"');
    expect(entry).not.toContain("'./native'");
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

describe("tick-by-tick quote updates", () => {
  const contract = {
    symbol: "AAPL",
    secType: SecType.STK,
    currency: "USD",
  };
  const details: ContractDetails = {
    contract: contract as any,
    validExchanges: "NASDAQ,SMART",
    longName: "Apple Inc.",
  } as ContractDetails;

  test("applies trade ticks to the latest quote", () => {
    const current = {
      symbol: "AAPL",
      providerId: "ibkr" as const,
      price: 249,
      currency: "USD",
      change: 1,
      changePercent: 0.4,
      previousClose: 248,
      name: "Apple Inc.",
      lastUpdated: 1000,
      dataSource: "live" as const,
    };
    const tick: TickByTickAllLast = {
      time: 1_700_000_000,
      price: 250.5,
      size: 100,
      tickType: 1,
      tickAttribLast: {},
      exchange: "NASDAQ",
      specialConditions: "",
      contract: contract as any,
    };

    const next = applyTickByTickAllLastToQuote(current, contract as any, details, tick, 1, "live");

    expect(next?.price).toBe(250.5);
    expect(next?.change).toBe(2.5);
    expect(next?.changePercent).toBeCloseTo((2.5 / 248) * 100, 10);
    expect(next?.lastUpdated).toBe(1_700_000_000_000);
  });

  test("does not use the previous tick as the daily close when no close is known", () => {
    const current = {
      symbol: "AAPL",
      providerId: "ibkr" as const,
      price: 249,
      currency: "USD",
      change: 0,
      changePercent: 0,
      name: "Apple Inc.",
      lastUpdated: 1000,
      dataSource: "live" as const,
    };
    const tick: TickByTickAllLast = {
      time: 1_700_000_000,
      price: 250.5,
      size: 100,
      tickType: 1,
      tickAttribLast: {},
      exchange: "NASDAQ",
      specialConditions: "",
      contract: contract as any,
    };

    const next = applyTickByTickAllLastToQuote(current, contract as any, details, tick, 1, "live");

    expect(next?.price).toBe(250.5);
    expect(next?.previousClose).toBeUndefined();
    expect(next?.change).toBe(0);
    expect(next?.changePercent).toBe(0);
  });

  test("applies bid/ask ticks without disturbing the current trade price", () => {
    const current = {
      symbol: "AAPL",
      providerId: "ibkr" as const,
      price: 249,
      currency: "USD",
      change: 1,
      changePercent: 0.4,
      previousClose: 248,
      bid: 248.8,
      ask: 249.1,
      bidSize: 10,
      askSize: 12,
      name: "Apple Inc.",
      lastUpdated: 1000,
      dataSource: "live" as const,
    };

    const next = applyTickByTickBidAskToQuote(current, {
      time: 1_700_000_100,
      bidPrice: 248.9,
      askPrice: 249.05,
      bidSize: 14,
      askSize: 18,
    }, 1);

    expect(next?.price).toBe(249);
    expect(next?.bid).toBe(248.9);
    expect(next?.ask).toBe(249.05);
    expect(next?.bidSize).toBe(14);
    expect(next?.askSize).toBe(18);
    expect(next?.lastUpdated).toBe(1_700_000_100_000);
  });
});

describe("parseIbkrHistoricalBarTime", () => {
  test("parses compact day bars without treating them as epoch seconds", () => {
    const date = parseIbkrHistoricalBarTime(20250328);

    expect(Number.isNaN(date.getTime())).toBe(false);
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(28);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  test("parses compact intraday bar timestamps", () => {
    const date = parseIbkrHistoricalBarTime("20250328 09:30:00");

    expect(Number.isNaN(date.getTime())).toBe(false);
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(28);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(30);
    expect(date.getSeconds()).toBe(0);
  });

  test("preserves epoch-second timestamps for streaming-style bars", () => {
    expect(parseIbkrHistoricalBarTime(1_700_000_000).getTime()).toBe(1_700_000_000_000);
  });
});

describe("diagnoseLocalIbkrPortIssue", () => {
  test("reports a detected local IBKR listener on a different port", async () => {
    const issue = await diagnoseLocalIbkrPortIssue({
      host: "127.0.0.1",
      port: 4002,
      clientId: 1,
    }, {
      candidatePorts: [4001, 4002],
      probePort: async (_host, port) => port === 4001,
    });

    expect(issue).toBe(
      "IBKR is not listening on 127.0.0.1:4002. Detected a local IBKR API listener on 127.0.0.1:4001 instead. Update this profile's port to match Gateway/TWS.",
    );
  });

  test("returns null when the configured local port is reachable", async () => {
    const issue = await diagnoseLocalIbkrPortIssue({
      host: "localhost",
      port: 4001,
      clientId: 1,
    }, {
      candidatePorts: [4001, 4002],
      probePort: async (_host, port) => port === 4001,
    });

    expect(issue).toBeNull();
  });

  test("ignores non-local hosts", async () => {
    const issue = await diagnoseLocalIbkrPortIssue({
      host: "192.168.1.10",
      port: 4001,
      clientId: 1,
    }, {
      probePort: async () => true,
    });

    expect(issue).toBeNull();
  });
});

describe("resolveGatewayConnection", () => {
  test("auto-detects the first reachable local IBKR port", async () => {
    const resolved = await resolveGatewayConnection({
      host: "127.0.0.1",
      marketDataType: "auto",
    }, {
      candidatePorts: [4001, 4002],
      probePort: async (_host, port) => port === 4001,
    });

    expect(resolved).toEqual({
      host: "127.0.0.1",
      port: 4001,
      clientId: 1,
      requestedPort: undefined,
      requestedClientId: 1,
    });
  });

  test("prefers the last successful local port before scanning defaults", async () => {
    const resolved = await resolveGatewayConnection({
      host: "127.0.0.1",
      lastSuccessfulPort: 7497,
      lastSuccessfulClientId: 12,
      marketDataType: "auto",
    }, {
      candidatePorts: [4001, 4002, 7497],
      probePort: async (_host, port) => port === 7497 || port === 4001,
    });

    expect(resolved).toEqual({
      host: "127.0.0.1",
      port: 7497,
      clientId: 12,
      requestedPort: 7497,
      requestedClientId: 12,
    });
  });
});

describe("IbkrGatewayService", () => {
  test("requests fixed-resolution chart history with the mapped IBKR bar size", async () => {
    const service = new IbkrGatewayService("ibkr-test");
    let requestArgs: { duration: string; barSize: BarSizeSetting } | null = null;
    (service as any).connect = async () => {};
    (service as any).resolveContract = async () => ({ symbol: "AAPL", exchange: "SMART", currency: "USD" });
    (service as any).getPrimaryContractDetails = async () => undefined;
    (service as any).withMarketDataFallback = async (task: () => Promise<unknown>) => task();
    (service as any).api = {
      getHistoricalData: async (_contract: unknown, _end: string, duration: string, barSize: BarSizeSetting) => {
        requestArgs = { duration, barSize };
        return [{
          time: "20260330",
          open: 99,
          high: 101,
          low: 98,
          close: 100,
          volume: 10,
        }];
      },
    };

    const history = await service.getPriceHistoryForResolution(
      "AAPL",
      { host: "127.0.0.1", marketDataType: "auto" },
      "NASDAQ",
      "1Y",
      "1wk",
    );

    expect(requestArgs!).toEqual({
      duration: "1 Y",
      barSize: BarSizeSetting.WEEKS_ONE,
    });
    expect(history[0]?.close).toBe(100);
  });

  test("enriches imported positions with portfolio snapshot metrics", async () => {
    const contract = {
      conId: 123456,
      symbol: "SPY",
      localSymbol: "SPY  260619C00500000",
      description: "SPY Jun19'26 500 Call",
      exchange: "SMART",
      primaryExch: "SMART",
      currency: "USD",
      secType: "OPT",
      multiplier: "100",
    };
    const service = new IbkrGatewayService("ibkr-test");
    (service as any).connect = async () => {};
    (service as any).api = {
      getPositions: () => of({
        all: new Map([
          ["DU12345", [{
            contract,
            pos: 2,
            avgCost: 3.5,
          }]],
        ]),
      }),
      getAccountUpdates: (accountId: string) => of({
        all: {
          portfolio: new Map([
            [accountId, [{
              contract,
              avgCost: 3.5,
              marketPrice: 4.25,
              marketValue: 850,
              unrealizedPNL: 150,
            }]],
          ]),
        },
      }),
    };

    const positions = await service.getPositions({
      host: "127.0.0.1",
      port: 4002,
      clientId: 1,
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      ticker: "SPY  260619C00500000",
      accountId: "DU12345",
      avgCost: 3.5,
      markPrice: 4.25,
      marketValue: 850,
      unrealizedPnl: 150,
      multiplier: "100",
      side: "long",
    });
  });

  test("keeps the broker status connected when post-connect requests fail", () => {
    const connectionState = new Subject<ConnectionState>();
    const error = new Subject<any>();
    const service = new IbkrGatewayService("ibkr-test");
    const fakeApi = {
      connectionState,
      error,
      on() {},
      off() {},
    };

    (service as any).api = fakeApi;
    (service as any).bindConnectionEvents(fakeApi);

    connectionState.next(ConnectionState.Connected);
    error.next({ errorCode: 321, message: "Validation failed" });

    expect(service.getSnapshot().status.state).toBe("connected");
    expect(service.getSnapshot().lastError).toBe("Validation failed");
  });

  test("initial connection refreshes account snapshots without re-entering connect", async () => {
    const connectionState = new Subject<ConnectionState>();
    const error = new Subject<any>();
    const service = new IbkrGatewayService("ibkr-test");
    const fakeApi = {
      isConnected: false,
      connectionState,
      error,
      connect() {
        fakeApi.isConnected = true;
        queueMicrotask(() => connectionState.next(ConnectionState.Connected));
      },
      setMarketDataType() {},
      getManagedAccounts: async () => ["DU12345"],
      getAccountSummary: () => of({
        all: new Map([
          ["DU12345", makeTags({
            NetLiquidation: { USD: "1000" },
          })],
        ]),
      }),
      getAllOpenOrders: async () => [],
      getExecutionDetails: async () => [],
      on() {},
      off() {},
    };

    (service as any).api = fakeApi;
    (service as any).configKey = "test-key";
    (service as any).bindConnectionEvents(fakeApi);

    await Promise.race([
      (service as any).connectInternal({
        host: "127.0.0.1",
        port: 4002,
        clientId: 1,
        marketDataType: "auto",
      }, "test-key"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connectInternal timed out")), 100)),
    ]);

    expect(service.getSnapshot().status.state).toBe("connected");
    expect(service.getSnapshot().accounts[0]?.netLiquidation).toBe(1000);
    expect(service.getSnapshot().openOrders).toEqual([]);
    expect(service.getSnapshot().executions).toEqual([]);
  });

  test("destroyAll disconnects every cached gateway service", async () => {
    const manager = new IbkrGatewayServiceManager();
    let disconnectCount = 0;

    (manager as any).services.set("one", {
      disconnect: async () => {
        disconnectCount += 1;
      },
    });
    (manager as any).services.set("two", {
      disconnect: async () => {
        disconnectCount += 1;
      },
    });

    await manager.destroyAll();

    expect(disconnectCount).toBe(2);
    expect((manager as any).services.size).toBe(0);
  });
});
