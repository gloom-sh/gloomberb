import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../types/financials";
import { createDefaultConfig } from "../types/config";
import { createTestDataProvider } from "../test-support/data-provider";
import { createSnapshotDataProvider } from "../market-data/snapshot-provider";
import { chartHeadless, loadChartPaneModel, type ChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { buildIntradayPriceChartPreset } from "../plugins/builtin/chart-composer/presets";
import { loadIntradayWindow, resolveIntradaySessionWindow } from "./session-history";

// Synthetic domain boundary, not a replay of a published exchange tape. CME
// permits negative CL prices: cmegroup.com/notices/clearing/2020/04/Chadv20-160.html
function bars(values: number[], date = "2020-04-20"): PricePoint[] {
  return values.map((close, minute) => ({
    date: new Date(`${date}T18:${String(minute).padStart(2, "0")}:00Z`),
    open: close, high: close + 0.1, low: close - 0.1, close, volume: 100 + minute,
  }));
}

function quote(instrumentType?: string, symbol = "CL=F"): Quote {
  return { symbol, instrumentType, price: 999, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() };
}

const request = { rangePreset: "1D", resolution: "1m", session: "2020-04-20" } as const;

async function modelFor(points: PricePoint[], reportedQuote: Quote | Error, log = false) {
  let quoteCalls = 0;
  const provider = createTestDataProvider({
    async getQuote() { quoteCalls++; if (reportedQuote instanceof Error) throw reportedQuote; return reportedQuote; },
    getPriceHistoryForResolution: async () => points,
    getDetailedPriceHistory: async () => points,
  });
  const spec = buildIntradayPriceChartPreset("CL=F:NYMEX");
  if (log) spec.panels[0]!.scale = "log";
  const model = await chartHeadless("graph-intraday-price-pane").load({
    rawArgument: "CL=F:NYMEX", argument: "CL=F:NYMEX", symbols: ["CL=F:NYMEX"], options: { session: request.session },
  }, {
    marketData: provider, apiClient: {} as never,
    config: createDefaultConfig("/tmp/gloom-session-domain-test"),
    signal: new AbortController().signal, settings: { chartSpec: spec },
  }) as ChartPaneModel;
  return { model, quoteCalls };
}

describe("intraday price domains", () => {
  test("GIP preserves futures price, OHLC and volume through zero/negative prices without appending the metadata quote", async () => {
    const points = bars([17.73, 0, -37.63, 1.5]);
    const { model, quoteCalls } = await modelFor(points, quote("FUTURE"));
    const price = model.chart.series[0]!;
    expect(price.points.map(({ value }) => value)).toEqual([17.73, 0, -37.63, 1.5]);
    expect(price.points.map(({ open, high, low, close, volume }) => ({ open, high, low, close, volume })))
      .toEqual(points.map(({ open, high, low, close, volume }) => ({ open, high, low, close, volume })));
    expect(model.chart.series[1]?.points.map(({ value }) => value)).toEqual([100, 101, 102, 103]);
    expect(model.chart.series[1]?.unit).toBe("contracts");
    expect(model.errors).toEqual([]);
    expect(model.unavailableSymbols).toEqual([]);
    expect(quoteCalls).toBe(1);
  });

  test("a nonpositive-only latest futures session is retained instead of falling back to an older positive session", async () => {
    const points = [...bars([10, 11], "2020-04-19"), ...bars([0, -37.63])];
    const provider = createTestDataProvider({ getQuote: async () => quote("FUT"), getPriceHistoryForResolution: async () => points });
    const loaded = await loadIntradayWindow({ provider, symbol: "CL=F", exchange: "NYMEX", request: { ...request, session: null } });
    expect(loaded.points.map(({ close }) => close)).toEqual([0, -37.63]);
    expect(loaded.sessionDates).toEqual(["2020-04-20"]);
    expect(loaded.unavailableReason).toBeNull();
  });

  test("unverified, equity and option domains fail visibly and retain rejected observations in generic JSON metadata", async () => {
    for (const reported of [quote(), quote("EQUITY"), quote("ETF"), quote("OPTION"), quote("FUTURE", "OTHER"), new Error("metadata unavailable")]) {
      const points = bars([17.73, 0, -37.63, 1.5]);
      const { model } = await modelFor(points, reported);
      expect(model.chart.series.every(({ points }) => points.length === 0)).toBe(true);
      expect(model.complete).toBe(false);
      expect(model.unavailableSymbols).toEqual(["CL=F:NYMEX"]);
      expect(model.errors?.join(" ")).toContain("nonpositive");
      const failure = model.snapshot.intradayHistories[0]!.priceDomainFailure!;
      expect(failure.sourcePoints.map(({ close }) => close)).toEqual([0, -37.63]);
      expect(failure.sourcePoints.map(({ date }) => date)).toEqual(points.slice(1, 3).map(({ date }) => date.toISOString()));
      expect(model.metadata?.intradayPriceDomainFailures).toEqual([{ symbol: "CL=F", exchange: "NYMEX", ...failure }]);
      expect(Object.isFrozen(failure.sourcePoints)).toBe(true);
      expect(Object.isFrozen(failure.sourcePoints[0])).toBe(true);
      points[1]!.close = 123;
      expect(failure.sourcePoints[0]!.close).toBe(0);
    }
  });

  test("required earlier study inputs cannot bridge bad equity bars, but observations after the selected window do not reject it", async () => {
    const selected = bars([10, 11]);
    const before = await modelFor([...bars([-1, 2], "2020-04-19"), ...selected], quote("EQUITY"));
    expect(before.model.complete).toBe(false);
    expect(before.model.snapshot.intradayHistories[0]?.priceDomainFailure?.sourcePoints[0]?.date).toBe("2020-04-19T18:00:00.000Z");
    const after = await modelFor([...selected, ...bars([-1, 2], "2020-04-21")], quote("EQUITY"));
    expect(after.model.chart.series[0]?.points.map(({ value }) => value)).toEqual([10, 11]);
    expect(after.model.errors).toEqual([]);
  });

  test("timestamp corrections supersede an earlier rejected close and positive histories incur no domain metadata request", async () => {
    const points = bars([0, 11]);
    points.push({ ...points[0]!, close: 10, open: 10, high: 11, low: 9 });
    let calls = 0;
    const loaded = await loadIntradayWindow({
      provider: createTestDataProvider({ getDetailedPriceHistory: async () => points, getQuote: async () => { calls++; return quote("EQUITY"); } }),
      symbol: "CL=F", exchange: "NYMEX", request,
    });
    expect(loaded.points.map(({ close }) => close)).toEqual([10, 11]);
    expect(loaded.unavailableReason).toBeNull();
    expect(calls).toBe(0);
    expect((await modelFor(bars([10, 11]), quote("EQUITY"))).quoteCalls).toBe(1);
    expect(resolveIntradaySessionWindow(bars([0, -1]), { rangePreset: "1D" }).points).toHaveLength(2);
  });

  test("futures permission preserves independent OHLC quarantine and logarithmic-scale guards", async () => {
    const points = bars([10, -2, 3]);
    points[1]!.high = -3;
    const { model } = await modelFor(points, quote("FUTURE"));
    expect(model.chart.series[0]?.points.map(({ value }) => value)).toEqual([10, null, 3]);
    expect(model.complete).toBe(false);
    expect(model.chart.priceHistoryIntegrity?.[0]?.integrity.sourcePoints[0]?.close).toBe(-2);
    const log = await modelFor(bars([10, 0, -2, 3]), quote("FUTURE"), true);
    expect(log.model.chart.warnings.join(" ")).toContain("2 non-positive observations");
    expect(log.model.chart.series[0]?.points.map(({ value }) => value)).toEqual([10, 0, -2, 3]);
  });

  test("a captured domain quote serves scalar and batch metadata without inventing company financials", async () => {
    const captured = quote("FUTURE");
    const provider = createSnapshotDataProvider({ financials: [], intradayHistories: [{
      symbol: "CL=F", exchange: "NYMEX", resolution: "1m", points: bars([-1, -2]), unavailableReason: null, quote: captured,
    }] }, createTestDataProvider());
    expect(await provider.getQuote("CL=F", "NYMEX")).toBe(captured);
    expect((await provider.getQuotesBatch!([{ symbol: "CL=F", exchange: "NYMEX" }]))[0]?.quote).toBe(captured);
    await expect(provider.getTickerFinancials("CL=F", "NYMEX")).rejects.toThrow("unused");
    await expect(provider.getQuote("CL=F", "OTHER")).rejects.toThrow("unused");
  });

  test("captured GIP domain failures survive the chart reload used by rendered screenshots", async () => {
    const { model } = await modelFor(bars([17.73, 0, -37.63, 1.5]), quote("EQUITY"));
    const reason = model.snapshot.intradayHistories[0]!.unavailableReason!;
    expect(model.errors).toHaveLength(1);
    for (const exactWindow of [true, false]) {
      let calls = 0;
      const snapshot = createSnapshotDataProvider(model.snapshot, createTestDataProvider({
        getPriceHistoryForResolution: async () => { calls++; return bars([10, 11]); },
        getDetailedPriceHistory: async () => { calls++; return bars([10, 11]); },
      }));
      const spec = { ...model.spec, viewport: { ...model.spec.viewport } };
      if (!exactWindow) delete spec.viewport.dateWindow;
      const reloaded = await loadChartPaneModel(spec, {
        marketData: snapshot, apiClient: {} as never,
        config: createDefaultConfig("/tmp/gloom-session-domain-reload"),
        signal: new AbortController().signal,
      });
      expect(reloaded.errors).toHaveLength(1);
      expect(reloaded.errors?.[0]).toContain(reason);
      expect(reloaded.chart.warnings.some((warning) => warning.includes(reason))).toBe(true);
      expect(reloaded.chart.warnings.join(" ")).not.toContain("Choose Auto");
      expect(reloaded.series.every(({ points }) => points.length === 0)).toBe(true);
      expect(calls).toBe(0);
    }
  });
});
