import { expect, test } from "bun:test";
import { CHART_SPEC_VERSION, type ChartSpec, type ResolvedSeries, type TimeSeriesPoint } from "../../../time-series/types";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestResolvedSeries } from "../../../test-support/time-series";
import { resolveChartSpecData } from "../../../time-series/resolve";
import { applyCompositeChartCursor, buildCompositeChartScene, compositeCursorAsOf, resolveAdjacentCompositeCursorDate, resolveCompositeCursorDate } from "./scene";
import { countMeasureBars } from "./tools";
import { pricePointIntegrity } from "../../../utils/price-history-integrity";
import { reuseResolvedSeriesIdentity } from "./panel-series";

function market(id: string, zone: string, dates: string[], values: number[]): ResolvedSeries {
  return createTestResolvedSeries({
    id, color: "#ffffff", unit: "%", unitGroup: "percent", transform: "percent",
    timeBasis: { kind: "market", timeZone: zone, cadenceMs: 86_400_000 },
    points: dates.map((date, index) => ({ date: new Date(date), value: values[index]! })),
  });
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


test("a quarantined crypto observation stays selectable beside an exchange session", () => {
  const crypto = { ...asx(), id: "BTC", observationKind: "market" as const, timeBasis: undefined };
  const invalidDate = new Date("2026-01-09T00:00:00Z");
  const integrity = pricePointIntegrity({ date: invalidDate, open: 120, high: 110, low: 90, close: 100 })!;
  crypto.points = [
    { date: new Date("2026-01-08"), value: 100 },
    { date: invalidDate, value: null, provenance: { priceHistoryIntegrity: integrity } },
  ];
  const scene = buildCompositeChartScene([us(), crypto], [{ id: "main" }], { width: 101, height: 20 })!;
  expect(scene.dates.some(date => date.getTime() === invalidDate.getTime())).toBe(true);
  const selected = applyCompositeChartCursor(scene, invalidDate);
  expect(selected.cursorDate?.getTime()).toBe(invalidDate.getTime());
  expect(selected.cursorValues.find(value => value.seriesId === "BTC")?.value).toBeNull();
  expect(selected.cursorValues.find(value => value.seriesId === "BTC")?.point?.provenance?.priceHistoryIntegrity).toEqual(integrity);
});

test("a cursor time from another chart lands on the bar at or before it, and on none outside the view", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"].map(day => `${day}T14:30:00Z`);
  const daily = market("D", "America/New_York", days, [1, 2, 3, 4, 5]);
  const scene = buildCompositeChartScene([daily], [{ id: "main" }], { width: 101, height: 20 })!;
  const linked = (iso: string) => applyCompositeChartCursor(scene, new Date(iso), "linked");
  // An intraday time late on the 7th is nearer the 8th's bar, yet it is the 7th's.
  const lateSeventh = linked("2026-01-08T13:00:00Z");
  expect(lateSeventh.cursorDate?.toISOString()).toBe("2026-01-07T14:30:00.000Z");
  expect(lateSeventh.cursorValues[0]?.value).toBe(3);
  expect(applyCompositeChartCursor(scene, new Date("2026-01-08T13:00:00Z")).cursorDate?.toISOString())
    .toBe("2026-01-08T14:30:00.000Z");
  // Before the first bar there is no bar it is on.
  expect(linked("2026-01-05T10:00:00Z").cursorDate).toBeNull();
  // After the newest bar, even past the drawn edge, it is still that bar.
  expect(linked("2026-03-01T00:00:00Z").cursorDate?.toISOString()).toBe("2026-01-09T14:30:00.000Z");
  // A chart panned back to earlier bars does not pin a later time to its right edge.
  const earlier = buildCompositeChartScene([daily], [{ id: "main" }], {
    width: 101, height: 20, viewport: { start: new Date(days[0]!), end: new Date(days[2]!) }, clipToViewport: true,
  })!;
  const panned = applyCompositeChartCursor(earlier, new Date("2026-01-09T15:00:00Z"), "linked");
  expect(panned.cursorDate).toBeNull();
  expect(panned.cursorXRatio).toBeNull();
  // A monthly series, on calendar time, reads its latest month on any later day, but not panned back from it.
  const months = ["2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01"];
  const monthly = createTestResolvedSeries({ id: "M", color: "#ffffff", points: months.map((month, index) => ({ date: new Date(month), value: index })) });
  const latest = buildCompositeChartScene([monthly], [{ id: "main" }], { width: 101, height: 20 })!;
  expect(applyCompositeChartCursor(latest, new Date("2025-10-16T15:00:00Z"), "linked").cursorDate?.toISOString()).toBe("2025-04-01T00:00:00.000Z");
  const back = buildCompositeChartScene([monthly], [{ id: "main" }], {
    width: 101, height: 20, viewport: { start: new Date(months[0]!), end: new Date(months[1]!) }, clipToViewport: true,
  })!;
  expect(applyCompositeChartCursor(back, new Date("2025-10-16T15:00:00Z"), "linked").cursorDate).toBeNull();
});

test("a cursor is shared as its bar's last instant, so a daily and an intraday chart land on the same session", () => {
  // Daily bars stamped at midnight UTC, as date-only bars are; 30-minute bars over two New York sessions.
  const daily = createTestResolvedSeries({
    id: "D", color: "#ffffff", timeBasis: { kind: "market", timeZone: "America/New_York", cadenceMs: 86_400_000 },
    points: ["2026-01-07", "2026-01-08"].map((day, index) => ({ date: new Date(`${day}T00:00:00Z`), value: index })),
  });
  const intradayTimes = ["2026-01-07T14:30:00Z", "2026-01-07T20:30:00Z", "2026-01-08T14:30:00Z", "2026-01-08T20:30:00Z"];
  const intraday = createTestResolvedSeries({
    id: "I", color: "#ffffff", timeBasis: { kind: "market", timeZone: "America/New_York", cadenceMs: 1_800_000 },
    points: intradayTimes.map((time, index) => ({ date: new Date(time), value: index })),
  });
  const dailyScene = buildCompositeChartScene([daily], [{ id: "main" }], { width: 101, height: 20 })!;
  const intradayScene = buildCompositeChartScene([intraday], [{ id: "main" }], { width: 101, height: 20 })!;
  // The 8th's daily bar, stamped before that session opens, lands on the 8th's last bar, not the 7th's.
  const dailyAsOf = compositeCursorAsOf(dailyScene, new Date("2026-01-08T00:00:00Z"));
  expect(applyCompositeChartCursor(intradayScene, new Date(dailyAsOf), "linked").cursorDate?.toISOString()).toBe("2026-01-08T20:30:00.000Z");
  // The 7th's closing bar ends at its interval, not at the next morning's bar: it lands on the 7th.
  const closeAsOf = compositeCursorAsOf(intradayScene, new Date("2026-01-07T20:30:00Z"));
  expect(closeAsOf).toBe(Date.parse("2026-01-07T21:00:00Z") - 1);
  expect(applyCompositeChartCursor(dailyScene, new Date(closeAsOf), "linked").cursorDate?.toISOString()).toBe("2026-01-07T00:00:00.000Z");
  // A monthly series on calendar time shares a month through its end, its newest one included.
  const monthly = createTestResolvedSeries({ id: "M", color: "#ffffff", points: ["2025-11-01", "2025-12-01", "2026-01-01"].map((month, index) => ({ date: new Date(month), value: index })) });
  const monthlyScene = buildCompositeChartScene([monthly], [{ id: "main" }], { width: 101, height: 20 })!;
  expect(compositeCursorAsOf(monthlyScene, new Date("2025-11-01"))).toBe(Date.parse("2025-12-01") - 1);
  expect(applyCompositeChartCursor(dailyScene, new Date(compositeCursorAsOf(monthlyScene, new Date("2026-01-01"))), "linked").cursorDate?.toISOString())
    .toBe("2026-01-08T00:00:00.000Z");
});
