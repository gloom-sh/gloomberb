import { expect, test } from "bun:test";
import { CHART_SPEC_VERSION, type ChartSpec, type ResolvedSeries, type TimeSeriesPoint } from "../../../time-series/types";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { resolveChartSpecData } from "../../../time-series/resolve";
import { applyCompositeChartCursor, buildCompositeChartScene, resolveAdjacentCompositeCursorDate, resolveCompositeCursorDate } from "./scene";
import { countMeasureBars } from "./tools";
import { reuseResolvedSeriesIdentity } from "./panel-series";

function market(id: string, zone: string, dates: string[], values: number[]): ResolvedSeries {
  return {
    id, label: id, color: "#ffffff", unit: "%", unitGroup: "percent", nativeFrequency: "daily",
    dataShape: "scalar", style: "line", transform: "percent", axis: "left", panelId: "main", interpolation: "none",
    timeBasis: { kind: "market", timeZone: zone, cadenceMs: 86_400_000 },
    points: dates.map((date, index) => ({ date: new Date(date), value: values[index]! })),
  };
}
const asx = () => market("ASX", "Australia/Sydney", ["2026-01-07T23:00:00Z", "2026-01-08T23:00:00Z"], [0, 10]);
const us = () => market("US", "America/New_York", ["2026-01-08T14:30:00Z", "2026-01-09T14:30:00Z"], [0, 20]);

test("every cross-market endpoint remains inspectable by pointer and keyboard in either series order", () => {
  for (const entries of [[asx(), us()], [us(), asx()]]) {
    const scene = buildCompositeChartScene(entries, [{ id: "main" }], { width: 101, height: 20 })!;
    expect(scene.timeScale.kind === "market" && scene.timeScale.anchorSeriesId).toBe(entries[0]!.id);
    const sortedDates = entries.flatMap(entry => entry.points.map(point => point.date.toISOString())).sort();
    expect(scene.dates.map(date => date.toISOString())).toEqual(sortedDates);
    for (const entry of scene.panels[0]!.series) for (const projected of entry.points) {
      const requested = new Date(projected.timestamp);
      const pointerDate = resolveCompositeCursorDate(scene, projected.xRatio * (scene.width - 1));
      expect(pointerDate?.getTime()).toBe(requested.getTime());
      const inspected = applyCompositeChartCursor(scene, requested);
      expect(inspected.cursorDate?.getTime()).toBe(requested.getTime());
      expect(inspected.cursorValues.find(value => value.seriesId === entry.source.id)?.value).toBe(projected.value);
    }
    const last = resolveAdjacentCompositeCursorDate(scene, null, -1)!;
    expect(last.toISOString()).toBe("2026-01-09T14:30:00.000Z");
    expect(applyCompositeChartCursor(scene, last).cursorValues.find(value => value.seriesId === "US")?.value).toBe(20);
    let cursor = resolveAdjacentCompositeCursorDate(scene, null, 1)!;
    const traversed = [cursor.toISOString()];
    for (let index = 1; index < scene.dates.length; index++) {
      cursor = resolveAdjacentCompositeCursorDate(scene, cursor, 1)!;
      traversed.push(cursor.toISOString());
    }
    expect(traversed).toEqual(sortedDates);
    // Cursor observations are not a count of the primary market's bars.
    if (scene.timeScale.kind === "market") {
      expect(countMeasureBars(scene.timeScale.anchors.map(anchor => new Date(anchor.timestamp)), scene.startTime, scene.endTime)).toBe(2);
    }
  }
});

test("new market cursor slots neither expose unpublished filings nor add nonmarket source dates", () => {
  const published: TimeSeriesPoint = { date: new Date("2025-12-31"), value: 500, availableAt: new Date("2026-01-08T20:00:00Z") };
  const notYetPublished: TimeSeriesPoint = { date: new Date("2026-01-01"), value: 900, availableAt: new Date("2026-01-10T20:00:00Z") };
  const filing: ResolvedSeries = { ...asx(), id: "filing", timeBasis: undefined, transform: "raw", style: "columns", points: [published, notYetPublished] };
  const scene = buildCompositeChartScene([asx(), us(), filing], [{ id: "main" }], {
    width: 101, height: 20, clipToViewport: true,
    viewport: { start: new Date("2026-01-07T23:00:00Z"), end: new Date("2026-01-09T14:30:00Z") },
  })!;
  expect(scene.dates.map(date => date.toISOString())).toEqual([
    "2026-01-07T23:00:00.000Z", "2026-01-08T14:30:00.000Z", "2026-01-08T23:00:00.000Z", "2026-01-09T14:30:00.000Z",
  ]);
  expect(applyCompositeChartCursor(scene, new Date("2026-01-08T14:30:00Z")).cursorValues.find(value => value.seriesId === "filing")?.value).toBeNull();
  const publishedCursor = applyCompositeChartCursor(scene, new Date("2026-01-08T23:00:00Z"));
  expect(publishedCursor.cursorValues.find(value => value.seriesId === "filing")?.value).toBe(500);
  const projected = scene.panels[0]!.series.find(entry => entry.source.id === "filing")!.points;
  expect(projected).toHaveLength(1);
  expect(projected[0]!.point).toBe(published);
  expect(projected[0]!.xRatio).toBe(scene.panels[0]!.series.find(entry => entry.source.id === "ASX")!.points.at(-1)!.xRatio);
});

test("only finite visible market observations add cursor stops while a hidden primary preserves geometry", () => {
  const primary = asx();
  const secondary = us();
  secondary.points.push({ date: new Date("2026-01-09T14:15:00Z"), value: null });
  secondary.points.push({ date: new Date("2026-01-10T14:30:00Z"), value: 30 });
  const scene = buildCompositeChartScene([secondary], [{ id: "main" }], {
    width: 101, height: 20, timelineSeries: [primary, secondary], clipToViewport: true,
    viewport: { start: primary.points[0]!.date, end: new Date("2026-01-09T14:30:00Z") },
  })!;
  expect(scene.timeScale.kind === "market" && scene.timeScale.anchorSeriesId).toBe("ASX");
  expect(scene.dates.map(date => date.toISOString())).toEqual([
    "2026-01-07T23:00:00.000Z", "2026-01-08T14:30:00.000Z", "2026-01-08T23:00:00.000Z", "2026-01-09T14:30:00.000Z",
  ]);
});

test("resolved crypto weekend observations and their studies keep exact timestamps beside an equity market", async () => {
  const history: Record<string, Array<{ date: Date; close: number }>> = {
    "BTC-USD": ["2026-01-09", "2026-01-10", "2026-01-11"].map((date, index) => ({ date: new Date(date), close: 100 + index * 10 })),
    SPY: [{ date: new Date("2026-01-09T14:30:00Z"), close: 50 }],
  };
  const getHistory = async (symbol: string) => history[symbol] ?? [];
  const spec: ChartSpec = {
    version: CHART_SPEC_VERSION,
    viewport: { range: "1M", resolution: "1d", dateWindow: { start: "2026-01-09", end: "2026-01-11" } },
    panels: [{ id: "main" }],
    series: [["BTC-USD", "CCC"], ["SPY", "NYSE"]].map(([symbol, exchange]) => ({
      id: symbol!, source: { kind: "security", instrument: { symbol: symbol!, exchange }, fieldId: "market.close" },
      style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none",
    })),
    studies: [{ id: "sma", kind: "sma", inputSeriesIds: ["BTC-USD"], parameters: { period: 2 }, panelId: "main", axis: "left" }],
  };
  const result = await resolveChartSpecData(spec, {
    now: new Date("2026-01-12"),
    dataProvider: createTestDataProvider({
      getQuote: async symbol => ({ symbol, currency: "USD", instrumentType: symbol === "BTC-USD" ? "CRYPTOCURRENCY" : "ETF", price: history[symbol]!.at(-1)!.close, change: 0, changePercent: 0 }),
      getTickerFinancials: async symbol => ({ annualStatements: [], quarterlyStatements: [], priceHistory: history[symbol] ?? [] }),
      getDetailedPriceHistory: getHistory, getPriceHistory: getHistory, getPriceHistoryForResolution: getHistory,
    }),
    loadFredSeries: async () => ({ data: { observations: [], info: null }, fetchedAt: 0, stale: false, source: "network" as const }),
  });
  const crypto = result.series.find(entry => entry.id === "BTC-USD")!;
  const average = result.series.find(entry => entry.id === "sma")!;
  expect(crypto.timeBasis).toBeUndefined();
  // Retaining a previous render's identical points must not discard newly
  // established observation semantics at the identity-reuse boundary.
  const reusedCrypto = reuseResolvedSeriesIdentity({ ...crypto, observationKind: undefined }, crypto);
  const scene = buildCompositeChartScene(result.series.map(entry => entry.id === crypto.id ? reusedCrypto : entry), spec.panels, { width: 101, height: 20 })!;
  const projected = scene.panels[0]!.series.find(entry => entry.source.id === "BTC-USD")!.points;
  expect(projected.map(point => new Date(point.timestamp).toISOString())).toEqual(history["BTC-USD"]!.map(point => point.date.toISOString()));
  for (const point of projected) {
    expect(resolveCompositeCursorDate(scene, point.xRatio * (scene.width - 1))?.getTime()).toBe(point.timestamp);
    expect(applyCompositeChartCursor(scene, new Date(point.timestamp)).cursorValues.find(value => value.seriesId === "BTC-USD")?.value).toBe(point.value);
  }
  expect(crypto.observationKind).toBe("market");
  expect(average.observationKind).toBe("market");
  expect(scene.panels[0]!.series.find(entry => entry.source.id === "sma")!.points.map(point => point.value)).toEqual([105, 115]);
  const onlyCrypto = buildCompositeChartScene([crypto, average], spec.panels, { width: 101, height: 20 })!;
  expect(onlyCrypto.timeScale.kind).toBe("calendar");
  expect(onlyCrypto.dates.map(date => date.toISOString())).toEqual(history["BTC-USD"]!.map(point => point.date.toISOString()));
});
