import { expect, test } from "bun:test";
import { createSnapshotDataProvider } from "../market-data/snapshot-provider";
import { buildComparisonChartPreset } from "../plugins/builtin/chart-composer/presets";
import { loadChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { parseChartSpec, serializeChartSpec } from "../plugins/builtin/chart-composer/chart-spec";
import { createTestDataProvider } from "../test-support/data-provider";
import type { HeadlessPaneContext } from "../types/headless";
import { ChartResolveCache, resolveChartSpecData } from "./resolve";
import type { ChartResolutionSupport } from "./resolution";
import { createTestHeadlessContext } from "../test-support/headless";

const history = Array.from({ length: 368 }, (_, index) => ({
  date: new Date(Date.UTC(2025, 8, 14 + index)), close: 100 + index,
}));
const context = (marketData: HeadlessPaneContext["marketData"]) => createTestHeadlessContext({ marketData });
const noLive = createTestDataProvider({
  getQuote: async () => { throw Error("Unexpected live quote"); },
  getTickerFinancials: async () => { throw Error("Unexpected live financials"); },
  getDetailedPriceHistory: async () => { throw Error("Unexpected live history"); },
});

for (const start of ["2026-08-15", "2025-09-16", "2025-09-15"]) {
  test(`date-only daily window ${start} retains both endpoints and snapshot cadence`, async () => {
    const requests: Array<{ start: string; end: string; resolution: string }> = [];
    const provider = createTestDataProvider({
      getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "1Y" }, { resolution: "1wk", maxRange: "5Y" }],
      getQuoteMetadata: async (symbol, exchange) => ({ symbol, exchange, currency: "USD", instrumentType: "EQUITY" }),
      getDetailedPriceHistory: async (_symbol, _exchange, from, to, resolution) => {
        requests.push({ start: from.toISOString(), end: to.toISOString(), resolution });
        return history.filter(point => point.date >= from && point.date < to);
      },
    });
    const spec = buildComparisonChartPreset(["AAA:XNAS", "BBB:XTSE"]);
    spec.viewport = { range: "1Y", resolution: "1d", dateWindow: { start, end: "2026-09-15" } };
    const reopened = parseChartSpec(serializeChartSpec(spec))!;
    expect(reopened.viewport.resolution).toBe("1d");
    const model = await loadChartPaneModel(reopened, context(provider));
    expect(model.chart.resolution).toBe("1d");
    expect(model.errors).toEqual([]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.end).toBe("2026-09-16T00:00:00.000Z");
      expect(request.resolution).toBe("1d");
      expect(Date.parse(request.start)).toBeLessThanOrEqual(Date.parse(start));
      if (start === "2025-09-15") expect(request.start).toBe("2025-09-15T00:00:00.000Z");
    }
    for (const series of model.series) {
      expect(series.points[0]?.date.toISOString().slice(0, 10)).toBe(start);
      expect(series.points.at(-1)?.date.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    }
    const snapshot = JSON.parse(JSON.stringify(model.snapshot), (_key, value) =>
      value && typeof value === "object" && typeof value.date === "string" ? { ...value, date: new Date(value.date) } : value);
    const replay = await loadChartPaneModel(reopened, context(createSnapshotDataProvider(snapshot, noLive)));
    expect(replay.chart.resolution).toBe("1d");
    expect(replay.series).toEqual(model.series);
    expect(replay.metadata?.priceComparison).toEqual(model.metadata?.priceComparison);
  });
}

for (const dateWindow of [
  { start: "2025-09-14", end: "2026-09-15" },
  { start: "2025-09-15T00:00:00.000Z", end: "2026-09-15T00:00:00.001Z" },
]) {
  test(`a longer window still exceeds daily support: ${dateWindow.start} to ${dateWindow.end}`, async () => {
    const spec = buildComparisonChartPreset(["AAA:XNAS", "BBB:XTSE"]);
    spec.viewport = { range: "1Y", resolution: "1d", dateWindow };
    const provider = createTestDataProvider({
      getChartResolutionSupport: () => [{ resolution: "1d", maxRange: "1Y" }, { resolution: "1wk", maxRange: "5Y" }],
      getDetailedPriceHistory: async () => history,
    });
    const model = await loadChartPaneModel(spec, context(provider));
    expect(model.chart.resolution).toBe("1wk");
    expect(model.chart.warnings).toContain("1D data is unavailable for this range. Auto resolution was used instead.");
  });
}

test("ordinary trailing one-year daily snapshots keep their existing range semantics", async () => {
  const spec = buildComparisonChartPreset(["AAA:XNAS", "BBB:XTSE"]);
  spec.viewport = { range: "1Y", resolution: "1d" };
  const provider = createSnapshotDataProvider({ financials: ["AAA:XNAS", "BBB:XTSE"].map(key => [key, {
    annualStatements: [], quarterlyStatements: [], priceHistory: history.slice(0, -1),
  }]) }, noLive);
  const model = await resolveChartSpecData(spec, {
    dataProvider: provider, now: new Date("2026-09-15T00:00:00Z"), loadFredSeries: async () => { throw Error("Unexpected FRED call"); },
  });
  expect(model.resolution).toBe("1d");
  expect(model.priceComparison?.start).toBe(Date.parse("2025-09-15"));
  expect(model.priceComparison?.end).toBe(Date.parse("2026-09-15"));
});

for (const resolution of ["auto", "1d"] as const) for (const dailyMax of ["1Y", "6M"] as const) {
  test(`${resolution} calendar windows adopt delayed ${dailyMax} daily support without extending its cap`, async () => {
    let settle!: (support: ChartResolutionSupport[]) => void;
    const gate = new Promise<ChartResolutionSupport[]>(resolve => { settle = resolve; });
    const requests: string[] = [];
    const provider = createTestDataProvider({
      getChartResolutionSupport: () => gate,
      getDetailedPriceHistory: async (_symbol, _exchange, start, end, selected) => {
        requests.push(selected);
        return history.filter(point => point.date >= start && point.date < end);
      },
    });
    const spec = buildComparisonChartPreset(["AAA:XNAS", "BBB:XTSE"]);
    spec.viewport = { range: "1Y", resolution, dateWindow: { start: "2025-09-15", end: "2026-09-15" } };
    const cache = new ChartResolveCache();
    const sources = { dataProvider: provider, now: new Date("2026-09-16"),
      loadFredSeries: async () => { throw Error("Unexpected FRED call"); } };
    const provisional = await resolveChartSpecData(spec, sources, cache);
    expect(provisional.resolution).toBe("1d");
    expect(provisional.errors).toEqual([]);
    expect(requests).toEqual(["1d", "1d"]);

    settle([{ resolution: "1d", maxRange: dailyMax }, { resolution: "1wk", maxRange: "5Y" }]);
    await gate;
    // The awaited pass and a fresh one-shot loader must agree on the real cap.
    requests.length = 0;
    const settled = await resolveChartSpecData(spec, sources, cache, { awaitResolutionSupport: true });
    const oneShot = await loadChartPaneModel(spec, context(provider));
    const expected = dailyMax === "1Y" ? "1d" : "1wk";
    expect(settled.resolution).toBe(expected);
    expect(oneShot.chart.resolution).toBe(expected);
    expect(settled.errors).toEqual([]);
    expect(oneShot.errors).toEqual([]);
    expect(new Set(requests)).toEqual(new Set([expected]));
    if (dailyMax === "1Y") {
      expect(settled.priceComparison?.start).toBe(Date.parse("2025-09-15"));
      expect(settled.priceComparison?.end).toBe(Date.parse("2026-09-15"));
    }
  });
}
