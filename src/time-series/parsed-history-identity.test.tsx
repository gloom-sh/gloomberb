import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { createTestDataProvider } from "../test-support/data-provider";
import type { InstrumentRef } from "../market-data/request-types";
import { setSharedMarketDataCoordinator } from "../market-data/coordinator";
import type { PricePoint } from "../types/financials";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";
import { resolveChartSpecData, type ChartResolveSources } from "./resolve";
import { rememberParsedPriceHistory } from "./parsed-history-cache";
import { useChartResolution, type UseChartResolutionResult } from "./use-chart-resolution";

const tui = createOpenTuiTestHarness();
let latest: UseChartResolutionResult;
let selectInstrument: (instrument: InstrumentRef) => void;

afterEach(() => {
  setSharedMarketDataCoordinator(null);
});

const points = (close: number): PricePoint[] => [0, 1].map(index => ({
  date: new Date(Date.UTC(2025, 0, 2 + index)), close: close + index,
}));
const emptyFinancials = { annualStatements: [], quarterlyStatements: [], priceHistory: [] };
function contract(symbol: string, conId: number, brokerInstanceId = "account-a"): InstrumentRef {
  return { symbol, exchange: "CME", brokerId: "ibkr", brokerInstanceId,
    instrument: { symbol, exchange: "CME", secType: "FUT", brokerId: "ibkr", brokerInstanceId, conId },
  };
}
function spec(instrument: InstrumentRef): ChartSpec {
  return { version: CHART_SPEC_VERSION, viewport: { range: "ALL", resolution: "1d" }, panels: [{ id: "main" }], studies: [],
    series: [{ id: "price", panelId: "main", style: "line", transform: "raw", interpolation: "none", axis: "left",
      source: { kind: "security", instrument, fieldId: "market.close" } }],
  };
}
const values = () => latest.series.flatMap(series => series.points.map(point => point.value));
async function mount(initial: InstrumentRef, sources: ChartResolveSources) {
  function Harness() {
    const [instrument, setInstrument] = useState(initial);
    selectInstrument = setInstrument;
    latest = useChartResolution(spec(instrument), sources, { liveRefreshIntervalMs: 0 });
    return <text>{`${latest.loading ? "loading" : "settled"}:${JSON.stringify(values())}`}</text>;
  }
  await tui.render(<Harness />, { width: 60, height: 1 });
}
async function settle(predicate: () => boolean) {
  for (let iteration = 0; iteration < 100; iteration++) {
    await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
    if (predicate()) return;
  }
  throw new Error(`Chart did not settle: ${tui.frame()}`);
}
const sourcesFor = (dataProvider: ChartResolveSources["dataProvider"]): ChartResolveSources => ({
  dataProvider, now: new Date("2025-01-10T00:00:00Z"), loadFredSeries: async () => { throw new Error("Unexpected FRED request"); },
});

test("pending contract and public switches never display another contract's parsed candles", async () => {
  const first = contract("SEED-SWITCH", 10), second = contract("SEED-SWITCH", 20);
  const publicTarget: InstrumentRef = { symbol: first.symbol, exchange: "CME", instrument: null };
  const secondHistory = Promise.withResolvers<PricePoint[]>(), publicHistory = Promise.withResolvers<PricePoint[]>();
  const requested: Array<number | null> = [];
  const sources = sourcesFor(createTestDataProvider({
    getTickerFinancials: async () => emptyFinancials,
    getPriceHistoryForResolution: async (_symbol, _exchange, _range, _resolution, context) => {
      const id = context?.instrument?.conId ?? null;
      requested.push(id);
      return id === 10 ? points(101) : id === 20 ? secondHistory.promise : publicHistory.promise;
    },
  }));
  await mount(first, sources);
  await settle(() => !latest.loading && values().length === 2);
  expect(values()).toEqual([101, 102]);
  await act(async () => selectInstrument(second));
  await settle(() => requested.includes(20));
  expect(latest.loading).toBe(true);
  expect(values()).toEqual([]);
  expect(tui.frame()).toContain("loading:[]");
  await act(async () => secondHistory.resolve(points(201)));
  await settle(() => !latest.loading && values().length === 2);
  expect(values()).toEqual([201, 202]);

  await act(async () => selectInstrument(publicTarget));
  await settle(() => requested.includes(null));
  expect(latest.loading).toBe(true);
  expect(values()).toEqual([]);
  expect(tui.frame()).toContain("loading:[]");
  await act(async () => publicHistory.resolve(points(301)));
  await settle(() => !latest.loading && values().length === 2);
  expect(values()).toEqual([301, 302]);
});

test("parsed seeds retain broker account scope and still seed the exact previously loaded identity", async () => {
  const first = contract("SEED-ACCOUNT", 10), second = contract("SEED-ACCOUNT", 10, "account-b");
  const firstSource = sourcesFor(createTestDataProvider({ getTickerFinancials: async () => emptyFinancials,
    getPriceHistoryForResolution: async () => points(401),
  }));
  await resolveChartSpecData(spec(first), firstSource);
  const waiting = Promise.withResolvers<PricePoint[]>();
  const requested: string[] = [];
  const sources = sourcesFor(createTestDataProvider({ getTickerFinancials: async () => emptyFinancials,
    getPriceHistoryForResolution: async (_symbol, _exchange, _range, _resolution, context) => {
      requested.push(context?.brokerInstanceId ?? ""); return waiting.promise;
    },
  }));
  await mount(first, sources);
  await settle(() => requested.includes("account-a"));
  expect(latest.loading).toBe(true);
  expect(values()).toEqual([401, 402]);
  expect(tui.frame()).toContain("loading:[401,402]");
  await act(async () => selectInstrument(second));
  await settle(() => requested.includes("account-b"));
  expect(values()).toEqual([]);
  expect(tui.frame()).toContain("loading:[]");
  await act(async () => waiting.resolve(points(501)));
  await settle(() => !latest.loading && values().length === 2);
  expect(values()).toEqual([501, 502]);
});

test("public history does not reuse a legacy symbol-only seed of unknown contract ownership", async () => {
  const target: InstrumentRef = { symbol: "SEED-LEGACY", exchange: "CME", instrument: null };
  rememberParsedPriceHistory(`${target.symbol}|CME|ALL|1d`, points(901));
  const waiting = Promise.withResolvers<PricePoint[]>();
  let requested = false;
  await mount(target, sourcesFor(createTestDataProvider({ getTickerFinancials: async () => emptyFinancials,
    getPriceHistoryForResolution: async () => { requested = true; return waiting.promise; },
  })));
  await settle(() => requested);
  expect(latest.loading).toBe(true);
  expect(values()).toEqual([]);
  expect(tui.frame()).toContain("loading:[]");
  await act(async () => waiting.resolve(points(601)));
  await settle(() => !latest.loading && values().length === 2);
  expect(values()).toEqual([601, 602]);
});
