import { describe, expect, test } from "bun:test";
import {
  appendLiveQuotePoint,
  bucketOhlcSeries,
  projectChartData,
  resolveRenderMode,
  resolveStableOhlcProjectionOptions,
} from "./data";
import { stepCursorTowards } from "../cursor-motion";
import { buildChartScene, buildCursorTimeAxisSegments, buildTimeAxis, formatAxisValue, formatCursorAxisValue, renderChart, resolveChartAxisWidth, resolveChartPalette } from "./renderer";
import { buildCursorPriceAxisOverlay } from "../price-axis-labels";
import { resolveChartMarketSession, resolveExtendedHoursBackgroundSpans } from "../market-session";
import type { PricePoint, Quote } from "../../../types/financials";
import type { ChartRenderMode } from "./types";

const aggregationFixture: PricePoint[] = [
  { date: new Date("2024-01-02"), close: 10, volume: 100 },
  { date: new Date("2024-01-03"), open: 11, high: 14, low: 9, close: 13, volume: 150 },
  { date: new Date("2024-01-04"), open: 13, high: 15, low: 12, close: 14, volume: 200 },
  { date: new Date("2024-01-05"), open: 14, high: 16, low: 10, close: 11, volume: 250 },
];

const chartFixture: PricePoint[] = [
  { date: new Date("2024-01-02"), open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { date: new Date("2024-01-03"), open: 11, high: 13, low: 10, close: 12, volume: 120 },
  { date: new Date("2024-01-04"), open: 12, high: 12.5, low: 8, close: 9, volume: 140 },
  { date: new Date("2024-01-05"), open: 9, high: 11, low: 8.5, close: 10.5, volume: 160 },
];

const palette = resolveChartPalette({
  bg: "#000000",
  border: "#333333",
  borderFocused: "#ffff00",
  text: "#ffffff",
  textDim: "#777777",
  positive: "#00ff00",
  negative: "#ff0000",
}, "positive");

function quoteFixture(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "INTC",
    price: 129,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.parse("2026-05-15T20:30:00Z"),
    listingExchangeName: "NASDAQ",
    marketState: "REGULAR",
    ...overrides,
  };
}

function textLines(result: ReturnType<typeof renderChart>): string[] {
  return result.lines.map((line) => line.chunks.map((chunk) => chunk.text).join(""));
}

describe("bucketOhlcSeries", () => {
  test("preserves bucket open/close/high/low/volume with missing OHLC fields", () => {
    const buckets = bucketOhlcSeries(aggregationFixture, 2);

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({
      date: new Date("2024-01-03"),
      open: 10,
      high: 14,
      low: 9,
      close: 13,
      volume: 250,
    });
    expect(buckets[1]).toEqual({
      date: new Date("2024-01-05"),
      open: 13,
      high: 16,
      low: 10,
      close: 11,
      volume: 450,
    });
  });

  test("keeps interior OHLC buckets aligned to source bars while panning", () => {
    const source = Array.from({ length: 13 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, index + 1)),
      open: index,
      high: index + 10,
      low: index - 10,
      close: index + 0.5,
      volume: index + 1,
    })) as PricePoint[];

    const firstView = bucketOhlcSeries(source.slice(0, 12), 3, { sourceIndexOffset: 0 });
    const pannedView = bucketOhlcSeries(source.slice(1, 13), 3, { sourceIndexOffset: 1 });
    const firstSharedBucket = firstView[1];
    const secondSharedBucket = firstView[2];
    if (!firstSharedBucket || !secondSharedBucket) {
      throw new Error("Expected shared OHLC buckets");
    }

    expect(firstSharedBucket).toEqual({
      date: source[4]!.date,
      open: 1,
      high: 14,
      low: -9,
      close: 4.5,
      volume: 2 + 3 + 4 + 5,
    });
    expect(pannedView[0]).toEqual(firstSharedBucket);
    expect(pannedView[1]).toEqual(secondSharedBucket);
  });

  test("keeps source-aligned bucket count stable across small pans", () => {
    const source: PricePoint[] = [];
    let cursor = new Date(Date.UTC(2024, 0, 1));
    let sourceIndex = 0;
    while (source.length < 220) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) {
        source.push({
          date: new Date(cursor),
          open: sourceIndex,
          high: sourceIndex + 1,
          low: sourceIndex - 1,
          close: sourceIndex + 0.5,
          volume: sourceIndex + 1,
        });
        sourceIndex += 1;
      }
      cursor = new Date(cursor.getTime() + 24 * 3600_000);
    }

    const visibleCount = 160;
    const targetWidth = 40;
    const projectionOptions = resolveStableOhlcProjectionOptions({
      pointCount: visibleCount,
      sourceIndexOffset: 0,
      bucketWidth: targetWidth * 2,
      navigationPointCount: visibleCount,
    });
    const targetBucketCount = projectionOptions.ohlcTargetBucketCount!;
    const projectWindow = (start: number) => bucketOhlcSeries(
      source.slice(start, start + visibleCount),
      targetWidth,
      {
        ...projectionOptions,
        sourceIndexOffset: start,
      },
    );

    const first = projectWindow(0);
    const pannedOne = projectWindow(1);
    const pannedTwo = projectWindow(2);

    expect(first).toHaveLength(targetBucketCount);
    expect(pannedOne).toHaveLength(targetBucketCount);
    expect(pannedTwo).toHaveLength(targetBucketCount);
    expect(pannedOne[1]!).toEqual(first[1]!);
    expect(pannedTwo[1]!).toEqual(first[1]!);
  });

  test("plans stable OHLC buckets from navigation count when histories are comparable", () => {
    expect(resolveStableOhlcProjectionOptions({
      pointCount: 158,
      sourceIndexOffset: 12,
      bucketWidth: 80,
      navigationPointCount: 160,
    })).toMatchObject({
      ohlcBucketWidth: 80,
      ohlcSourceBucketSize: 4,
      ohlcTargetBucketCount: 40,
      sourceIndexOffset: 12,
    });
  });

  test("plans OHLC buckets from rendered points when navigation count is too different", () => {
    expect(resolveStableOhlcProjectionOptions({
      pointCount: 84,
      sourceIndexOffset: 0,
      bucketWidth: 80,
      navigationPointCount: 160,
    })).toMatchObject({
      ohlcSourceBucketSize: 3,
      ohlcTargetBucketCount: 28,
    });
  });
});

describe("appendLiveQuotePoint", () => {
  test("extends coarse chart histories with a fresh quote tail", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-04T00:00:00Z"), close: 56 },
      { date: new Date("2026-05-11T00:00:00Z"), close: 68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture(),
      { now: Date.parse("2026-05-15T21:00:00Z") },
    );

    expect(extended).toHaveLength(3);
    expect(extended.at(-1)).toEqual({
      date: new Date("2026-05-15T20:30:00Z"),
      close: 129,
    });
  });

  test("merges a quote into the active OHLC bucket", () => {
    const history: PricePoint[] = [
      {
        date: new Date("2026-05-15T20:25:00Z"),
        open: 124,
        high: 130,
        low: 122,
        close: 126,
        volume: 1_000,
      },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-05-15T20:29:00Z") }),
      {
        now: Date.parse("2026-05-15T20:30:00Z"),
        mode: "ohlc",
        resolution: "5m",
      },
    );

    expect(extended).toHaveLength(1);
    expect(extended[0]).toEqual({
      date: new Date("2026-05-15T20:25:00Z"),
      open: 124,
      high: 130,
      low: 122,
      close: 129,
      volume: 1_000,
    });
  });

  test("seeds a new OHLC bucket from the live price instead of prior-bar extremes", () => {
    const history: PricePoint[] = [
      {
        date: new Date("2026-05-15T20:25:00Z"),
        open: 124,
        high: 180,
        low: 80,
        close: 126,
        volume: 1_000,
      },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-05-15T20:30:00Z") }),
      {
        now: Date.parse("2026-05-15T20:31:00Z"),
        mode: "ohlc",
        resolution: "5m",
      },
    );

    expect(extended).toHaveLength(2);
    expect(extended[1]).toEqual({
      date: new Date("2026-05-15T20:30:00Z"),
      open: 129,
      high: 129,
      low: 129,
      close: 129,
    });
  });

  test("treats calendar-month bars as variable-length buckets", () => {
    const history: PricePoint[] = [{
      date: new Date("2026-01-01T00:00:00Z"),
      open: 120,
      high: 140,
      low: 110,
      close: 125,
    }];

    const endOfJanuary = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-01-31T20:30:00Z") }),
      {
        now: Date.parse("2026-01-31T20:31:00Z"),
        mode: "ohlc",
        resolution: "1mo",
      },
    );
    const startOfFebruary = appendLiveQuotePoint(
      history,
      quoteFixture({ lastUpdated: Date.parse("2026-02-01T20:30:00Z") }),
      {
        now: Date.parse("2026-02-01T20:31:00Z"),
        mode: "ohlc",
        resolution: "1mo",
      },
    );

    expect(endOfJanuary).toHaveLength(1);
    expect(endOfJanuary[0]?.close).toBe(129);
    expect(startOfFebruary).toHaveLength(2);
    expect(startOfFebruary[1]).toMatchObject({
      open: 129,
      high: 129,
      low: 129,
      close: 129,
    });
  });

  test("uses the active extended-hours price for the live tail", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-15T19:30:00Z"), close: 128 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        marketState: "POST",
        postMarketPrice: 131,
        lastUpdated: Date.parse("2026-05-15T21:10:00Z"),
      }),
      { now: Date.parse("2026-05-15T21:15:00Z") },
    );

    expect(extended.at(-1)?.close).toBe(131);
  });

  test("does not bridge a missing intraday history window with one synthetic candle", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-07-22T14:49:00Z"), close: 347.73 },
      { date: new Date("2026-07-22T14:50:00Z"), close: 347.76 },
      { date: new Date("2026-07-22T14:51:00Z"), close: 347.68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        symbol: "GOOG",
        price: 346.27,
        lastUpdated: Date.parse("2026-07-22T18:52:00Z"),
      }),
      Date.parse("2026-07-22T18:53:00Z"),
    );

    expect(extended).toBe(history);
  });

  test("does not append a live quote tail with a likely unit mismatch", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-18T00:00:00Z"), close: 405 },
      { date: new Date("2026-05-22T00:00:00Z"), close: 379 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        symbol: "FTC",
        currency: "GBP",
        price: 3.79,
        lastUpdated: Date.parse("2026-05-22T16:39:00Z"),
      }),
      { now: Date.parse("2026-05-22T16:45:00Z") },
    );

    expect(extended).toBe(history);
  });

  test("does not append stale quotes from an older active session", () => {
    const history: PricePoint[] = [
      { date: new Date("2026-05-11T00:00:00Z"), close: 68 },
    ];

    const extended = appendLiveQuotePoint(
      history,
      quoteFixture({
        lastUpdated: Date.parse("2026-05-08T20:00:00Z"),
      }),
      { now: Date.parse("2026-05-15T15:00:00Z") },
    );

    expect(extended).toBe(history);
  });
});

describe("resolveRenderMode", () => {
  test("applies candle fallback thresholds", () => {
    expect(resolveRenderMode("candles", 27)).toMatchObject({ effectiveMode: "line", fallbackMode: "line" });
    expect(resolveRenderMode("candles", 28)).toMatchObject({ effectiveMode: "ohlc", fallbackMode: "ohlc" });
    expect(resolveRenderMode("candles", 39)).toMatchObject({ effectiveMode: "ohlc", fallbackMode: "ohlc" });
    expect(resolveRenderMode("candles", 40)).toMatchObject({ effectiveMode: "candles", fallbackMode: null });
    expect(resolveRenderMode("hlc", 27)).toMatchObject({ effectiveMode: "line", fallbackMode: "line" });
    expect(resolveRenderMode("hlc", 28)).toMatchObject({ effectiveMode: "hlc", fallbackMode: null });
  });

  test("forces compact charts back to area mode", () => {
    const projection = projectChartData(chartFixture, 80, "candles", true);
    expect(projection.requestedMode).toBe("area");
    expect(projection.effectiveMode).toBe("area");
    expect(projection.fallbackMode).toBeNull();
  });

  test("uses fewer projected buckets for candles and ohlc-style bars to preserve spacing", () => {
    const denseSeries = Array.from({ length: 100 }, (_, i) => ({
      date: new Date(2024, 0, i + 1),
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1_000 + i,
    })) as PricePoint[];

    expect(projectChartData(denseSeries, 80, "candles", false).points).toHaveLength(34);
    expect(projectChartData(denseSeries, 80, "ohlc", false).points).toHaveLength(34);
    expect(projectChartData(denseSeries, 80, "hlc", false).points).toHaveLength(34);
    expect(projectChartData(denseSeries, 80, "line", false).points).toHaveLength(80);
  });

  test("keeps candle buckets stable when axis width changes the plot by one column", () => {
    const denseSeries = Array.from({ length: 121 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, index + 1)),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 1_000 + index,
    })) as PricePoint[];

    const wide = projectChartData(denseSeries, 80, "candles", false, { ohlcBucketWidth: 80 }).points;
    const narrowed = projectChartData(denseSeries, 78, "candles", false, { ohlcBucketWidth: 80 }).points;

    expect(narrowed.map((point) => point.date.toISOString())).toEqual(wide.map((point) => point.date.toISOString()));
    expect(narrowed.map((point) => point.open)).toEqual(wide.map((point) => point.open));
    expect(narrowed.map((point) => point.close)).toEqual(wide.map((point) => point.close));
  });
});

describe("renderChart", () => {
  test("sizes the y-axis to the visible label width instead of a fixed gutter", () => {
    expect(resolveChartAxisWidth(["$18", "$17", "$16", "$14"], 4, 10)).toBe(4);
    expect(resolveChartAxisWidth(["$1.1678", "$1.1654"], 4, 10)).toBe(7);
    expect(resolveChartAxisWidth(["+0.25%", "-0.10%"], 5, 11)).toBe(6);
  });

  test("formats price axes with the instrument currency", () => {
    expect(formatAxisValue(21_970, "price", 0, "JPY")).toBe("¥22.0K");
    expect(formatAxisValue(12_340, "price", 0, "HKD")).toBe("HK$12.3K");
    expect(formatAxisValue(1.17364, "price", 0, "USD", "CURRENCY")).toBe("$1.17364");
  });

  test("keeps legend and cursor prices precise while axis ticks stay compact", () => {
    expect(formatAxisValue(79_432.18, "price", 0, "USD", "CRYPTO")).toBe("$79.4K");
    expect(formatCursorAxisValue(79_432.18, "price", 0, "USD", "CRYPTO")).toBe("$79,432.18");
    expect(formatAxisValue(79_432.18, "price", 0, "USD", "STK")).toBe("$79.4K");
    expect(formatCursorAxisValue(79_432.18, "price", 0, "USD", "STK")).toBe("$79,432.18");
  });

  test("adapts FX axis precision to the visible price range", () => {
    expect(formatAxisValue(1.167815, "price", 0, "USD", "CURRENCY", 0.12)).toBe("$1.17");
    expect(formatAxisValue(1.167815, "price", 0, "USD", "CURRENCY", 0.0024)).toBe("$1.1678");
  });

  test("keeps the active price-axis label more precise than coarse grid ticks", () => {
    expect(formatAxisValue(21.184, "price", 0, "USD", "STK", 11)).toBe("$21");
    expect(formatCursorAxisValue(21.184, "price", 0, "USD", "STK", 11)).toBe("$21.18");
    expect(formatCursorAxisValue(1.167815, "price", 0, "USD", "CURRENCY", 0.12)).toBe("$1.1678");
  });

  test("keeps zoomed equity axis labels distinct and decimal-aware", () => {
    const narrowRangeFixture: PricePoint[] = [
      { date: new Date("2024-01-02T09:30:00Z"), close: 18.02, volume: 100 },
      { date: new Date("2024-01-02T09:31:00Z"), close: 17.91, volume: 120 },
      { date: new Date("2024-01-02T09:32:00Z"), close: 17.84, volume: 140 },
      { date: new Date("2024-01-02T09:33:00Z"), close: 17.73, volume: 160 },
    ];

    const result = renderChart(projectChartData(narrowRangeFixture, 32, "area", false).points, {
      width: 32,
      height: 8,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "area",
      axisMode: "price",
      currency: "USD",
      assetCategory: "STK",
      colors: palette,
    });

    expect(result.axisFractionDigits).toBeGreaterThanOrEqual(1);
    expect(new Set(result.axisLabels.map((entry) => entry.label)).size).toBe(result.axisLabels.length);
    expect(result.axisLabels.every((entry) => entry.label.includes("."))).toBe(true);
  });

  test("keeps indicator overlays out of the chart price range", () => {
    const projection = projectChartData(chartFixture, 12, "line", false);
    const baseScene = buildChartScene(projection.points, {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      colors: palette,
    });
    const sceneWithIndicators = buildChartScene(projection.points, {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      colors: palette,
      indicators: {
        smaLines: [{
          period: 2,
          color: "#ff00ff",
          points: [
            { index: 0, value: 6 },
            { index: 1, value: 18 },
          ],
        }],
        emaLines: [{
          period: 2,
          color: "#00ffff",
          points: [
            { index: 0, value: 4 },
            { index: 1, value: 20 },
          ],
        }],
        bollinger: {
          color: "#ffaa00",
          upper: [
            { index: 0, value: 22 },
            { index: 1, value: 23 },
          ],
          middle: [
            { index: 0, value: 14 },
            { index: 1, value: 15 },
          ],
          lower: [
            { index: 0, value: 3 },
            { index: 1, value: 4 },
          ],
        },
        rsi: null,
        macd: null,
      },
    });

    expect(sceneWithIndicators?.min).toBe(baseScene?.min);
    expect(sceneWithIndicators?.max).toBe(baseScene?.max);
  });

  test("honors an explicit yDomain over the data range", () => {
    const projection = projectChartData(chartFixture, 12, "line", false);
    const scene = buildChartScene(projection.points, {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      colors: palette,
      yDomain: { min: 0, max: 500 },
    });
    expect(scene?.min).toBe(0);
    expect(scene?.max).toBe(500);
  });

  test("draws indicator overlays below price pixels", () => {
    const points: PricePoint[] = [
      { date: new Date("2024-01-02"), close: 10, volume: 100 },
      { date: new Date("2024-01-03"), close: 11, volume: 120 },
      { date: new Date("2024-01-04"), close: 12, volume: 140 },
    ];
    const result = renderChart(points, {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "line",
      colors: palette,
      indicators: {
        smaLines: [{
          period: 2,
          color: "#ff00ff",
          points: [
            { index: 0, value: 10 },
            { index: 1, value: 11 },
            { index: 2, value: 12 },
          ],
        }],
        emaLines: [],
        bollinger: null,
        rsi: null,
        macd: null,
      },
    });

    const pixels = result.pixelBuffer?.pixels.flat().filter(Boolean) ?? [];
    expect(pixels.some((pixel) => pixel?.color === palette.lineColor)).toBe(true);
    expect(pixels.some((pixel) => pixel?.color === "#ff00ff")).toBe(false);
  });

  test("normalizes fractional web dimensions before drawing volume bars", () => {
    const projection = projectChartData(chartFixture, 12, "area", false);
    const result = renderChart(projection.points, {
      width: 12.5,
      height: 7.3,
      showVolume: true,
      volumeHeight: 3,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      colors: palette,
    });

    expect(result.lines).toHaveLength(7);
    expect(result.pixelBuffer?.width).toBe(24);
    expect(result.pixelBuffer?.height).toBe(28);
    expect(result.axisLabels.every((entry) => Number.isInteger(entry.row))).toBe(true);
  });

  test("keeps terminal chart cells transparent", () => {
    const projection = projectChartData(chartFixture, 12, "area", false);
    const result = renderChart(projection.points, {
      width: 12,
      height: 5,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      colors: palette,
    });

    const chunks = result.lines.flatMap((line) => line.chunks);
    expect(chunks.some((chunk) => chunk.text.trim().length > 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.bg === undefined)).toBe(true);
  });

  test("keeps one decimal on zoomed equity axes even when whole-dollar ticks are distinct", () => {
    const mediumRangeFixture: PricePoint[] = [
      { date: new Date("2024-01-02T09:30:00Z"), close: 233.82, volume: 100 },
      { date: new Date("2024-01-02T09:45:00Z"), close: 232.14, volume: 120 },
      { date: new Date("2024-01-02T10:00:00Z"), close: 230.21, volume: 140 },
      { date: new Date("2024-01-02T10:15:00Z"), close: 231.67, volume: 160 },
      { date: new Date("2024-01-02T10:30:00Z"), close: 228.94, volume: 180 },
    ];

    const result = renderChart(projectChartData(mediumRangeFixture, 28, "area", false).points, {
      width: 28,
      height: 8,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "area",
      axisMode: "price",
      currency: "USD",
      assetCategory: "STK",
      colors: palette,
    });

    expect(result.axisFractionDigits).toBe(1);
    expect(result.axisLabels.every((entry) => entry.label.includes("."))).toBe(true);
  });

  test("eases coarse cursor motion quickly and settles without overshooting", () => {
    let current: { x: number | null; y: number | null } = { x: 2, y: 1 };
    const target = { x: 6, y: 4 };

    const firstStep = stepCursorTowards(current, target);
    expect(firstStep.settled).toBe(false);
    expect(firstStep.next.x!).toBeGreaterThan(current.x!);
    expect(firstStep.next.x!).toBeLessThan(target.x);
    expect(firstStep.next.y!).toBeGreaterThan(current.y!);
    expect(firstStep.next.y!).toBeLessThan(target.y);

    current = firstStep.next;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const nextStep = stepCursorTowards(current, target);
      current = nextStep.next;
      if (nextStep.settled) break;
    }

    expect(current).toEqual(target);
  });

  test("snaps directly when the coarse cursor has no active position", () => {
    expect(stepCursorTowards({ x: null, y: null }, { x: 8, y: 3 })).toEqual({
      next: { x: 8, y: 3 },
      settled: true,
    });
  });

  test("compresses dense short-range x-axis labels without repeating the month on every tick", () => {
    const dates = Array.from({ length: 31 }, (_, index) => new Date(2026, 0, index + 1));

    expect(buildTimeAxis(dates, 72)).toBe(
      "Jan 1  4         8     11     14       18     21     24        28 Jan 31",
    );
  });

  test("uses times instead of repeating the same calendar date for intraday ranges", () => {
    const dates = Array.from({ length: 13 }, (_, index) => new Date(2026, 0, 5, 9, 30 + index * 30));

    expect(buildTimeAxis(dates, 72)).toBe(
      "09:30     10:30 11:00       12:00      13:00       14:00 14:30     15:30",
    );
  });

  test("overlays the cursor date on the x-axis without changing its width", () => {
    const dates = Array.from({ length: 13 }, (_, index) => new Date(2026, 0, 5, 9, 30 + index * 30));
    const width = 72;
    const segments = buildCursorTimeAxisSegments({
      timeLabels: buildTimeAxis(dates, width),
      width,
      cursorColumn: 36,
      cursorDate: dates[6]!,
      dates,
    });

    expect(segments.map((segment) => segment.text).join("")).toHaveLength(width);
    expect(segments.find((segment) => segment.highlighted)?.text).toBe("12:30");
  });

  test("keeps day precision for cursor labels when the axis coarsens to months", () => {
    const dates = Array.from({ length: 12 }, (_, index) => new Date(2025, index, 1));
    const width = 48;
    const segments = buildCursorTimeAxisSegments({
      timeLabels: buildTimeAxis(dates, width),
      width,
      cursorColumn: 27,
      cursorDate: new Date(2025, 8, 15),
      dates,
    });

    expect(segments.find((segment) => segment.highlighted)?.text).toBe("Sep 15 2025");
  });

  test("positions desktop cursor y-axis overlay from exact pixels", () => {
    const height = 8;
    const cellHeightPx = 18;
    const cursorPixelY = 45.25;
    const overlay = buildCursorPriceAxisOverlay({
      axisWidth: 7,
      axisSectionWidth: 8,
      height,
      cursorPixelY,
      cursorLabel: "$214.03",
      cellHeightPx,
    });

    expect(overlay.labelText).toBe("$214.03");
    expect(overlay.topPercent).toBeCloseTo((cursorPixelY / (height * cellHeightPx - 1)) * 100, 5);
  });

  test("shows second precision when the visible window reaches second-level data", () => {
    const dates = Array.from({ length: 6 }, (_, index) => new Date(2026, 0, 5, 9, 30, index * 10));

    expect(buildTimeAxis(dates, 60)).toBe(
      "09:30:00            09:30:20   09:30:30             09:30:50",
    );
  });

  test("collapses identical timestamps into a single centered label", () => {
    const dates = Array.from({ length: 20 }, () => new Date(2026, 2, 29, 9, 0, 0, 0));

    expect(buildTimeAxis(dates, 96)).toBe(
      "                                          09:00:00.000                                          ",
    );
  });

  test("coarsens to month and year labels for longer spans", () => {
    const monthlyDates = Array.from({ length: 12 }, (_, index) => new Date(2025, index, 1));
    const yearlyDates = Array.from({ length: 6 }, (_, index) => new Date(2020 + index, 0, 1));

    expect(buildTimeAxis(monthlyDates, 48)).toBe("Jan 2025        May          Aug        Dec 2025");
    expect(buildTimeAxis(yearlyDates, 48)).toBe("2020   2021      2022     2023      2024    2025");
  });

  test("marks US premarket and postmarket bars for chart backgrounds", () => {
    const session = resolveChartMarketSession([{ exchange: "NASDAQ", currency: "USD", assetCategory: "STK" }]);
    const dates = [
      new Date("2026-05-14T11:00:00Z"),
      new Date("2026-05-14T14:00:00Z"),
      new Date("2026-05-14T20:30:00Z"),
    ];

    expect(resolveExtendedHoursBackgroundSpans(dates, session)).toEqual([
      { kind: "pre", startIndex: 0, endIndex: 0 },
      { kind: "post", startIndex: 2, endIndex: 2 },
    ]);
  });

  test("omits extended-hours backgrounds for wide intraday windows", () => {
    const session = resolveChartMarketSession([{ exchange: "NASDAQ", currency: "USD", assetCategory: "STK" }]);
    const dates = Array.from({ length: 12 }).flatMap((_, dayIndex) => {
      const day = 4 + dayIndex;
      return [
        new Date(Date.UTC(2026, 4, day, 11, 0)),
        new Date(Date.UTC(2026, 4, day, 14, 0)),
        new Date(Date.UTC(2026, 4, day, 20, 30)),
      ];
    });

    expect(resolveExtendedHoursBackgroundSpans(dates, session)).toEqual([]);
  });

  test("paints extended-hours chart cells as background colors", () => {
    const session = resolveChartMarketSession([{ exchange: "NASDAQ", currency: "USD", assetCategory: "STK" }]);
    const points: PricePoint[] = [
      { date: new Date("2026-05-14T11:00:00Z"), close: 10, volume: 100 },
      { date: new Date("2026-05-14T14:00:00Z"), close: 12, volume: 120 },
      { date: new Date("2026-05-14T20:30:00Z"), close: 11, volume: 110 },
    ];

    const result = renderChart(points, {
      width: 12,
      height: 4,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "line",
      colors: palette,
      marketSession: session,
    });

    const backgrounds = result.lines.flatMap((line) => line.chunks.map((chunk) => chunk.bg));
    expect(backgrounds).toContain(palette.preMarketBgColor);
    expect(backgrounds).toContain(palette.postMarketBgColor);
  });

  test("uses source time-axis dates instead of projected extrema dates when provided", () => {
    const sourceHistory = Array.from({ length: 96 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 2, 25, index * 3)),
      close: index % 2 === 0 ? 0.7 + index * 0.001 : 0.3 + index * 0.001,
      volume: 100 + index,
    })) as PricePoint[];
    const sourceDates = sourceHistory.map((point) => point.date);
    const projection = projectChartData(sourceHistory, 48, "area", true);

    const result = renderChart(projection.points, {
      width: 48,
      height: 8,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "area",
      axisMode: "price",
      currency: "USD",
      colors: palette,
      timeAxisDates: sourceDates,
    });

    expect(result.timeLabels).toBe(buildTimeAxis(sourceDates, 48));
  });

  test("maps active bucket metadata across all render modes", () => {
    const cases: Array<{ mode: ChartRenderMode; width: number; cursorX: number }> = [
      { mode: "area", width: 12, cursorX: 4 },
      { mode: "line", width: 12, cursorX: 4 },
      { mode: "candles", width: 40, cursorX: 13 },
      { mode: "ohlc", width: 28, cursorX: 9 },
      { mode: "hlc", width: 28, cursorX: 9 },
    ];

    for (const testCase of cases) {
      const projection = projectChartData(chartFixture, testCase.width, testCase.mode, false);
      const result = renderChart(projection.points, {
        width: testCase.width,
        height: 6,
        showVolume: false,
        volumeHeight: 0,
        cursorX: testCase.cursorX,
        cursorY: null,
        mode: projection.effectiveMode,
        colors: palette,
      });

      expect(result.activePoint?.date.toISOString()).toBe("2024-01-03T00:00:00.000Z");
      expect(result.activePoint?.close).toBe(12);
    }
  });

  test("keeps the visual cursor free-running on both axes", () => {
    const cases: Array<{ mode: ChartRenderMode; width: number; height: number; cursorX: number; cursorY: number }> = [
      { mode: "area", width: 12, height: 6, cursorX: 5, cursorY: 4 },
      { mode: "candles", width: 40, height: 6, cursorX: 13, cursorY: 3 },
      { mode: "ohlc", width: 28, height: 6, cursorX: 9, cursorY: 1 },
      { mode: "hlc", width: 28, height: 6, cursorX: 9, cursorY: 1 },
    ];

    for (const testCase of cases) {
      const projection = projectChartData(chartFixture, testCase.width, testCase.mode, false);
      const result = renderChart(projection.points, {
        width: testCase.width,
        height: testCase.height,
        showVolume: false,
        volumeHeight: 0,
        cursorX: testCase.cursorX,
        cursorY: testCase.cursorY,
        mode: projection.effectiveMode,
        colors: palette,
      });

      expect(result.cursorColumn).toBe(testCase.cursorX);
      expect(result.cursorRow).toBe(testCase.cursorY);
    }
  });

  test("uses fractional cursor rows for crosshair price readout", () => {
    const projection = projectChartData(chartFixture, 12, "line", false);
    const result = renderChart(projection.points, {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: 5.25,
      cursorY: 2.5,
      mode: projection.effectiveMode,
      colors: palette,
    });

    expect(result.cursorColumn).toBe(5);
    expect(result.cursorRow).toBe(3);
    expect(result.crosshairPrice).toBeCloseTo(10.5, 5);
  });

  test("renders stable terminal shapes for each chart mode", () => {
    const cases: Array<{ mode: ChartRenderMode; width: number; height: number; lines: string[]; timeLabels: string }> = [
      {
        mode: "area",
        width: 12,
        height: 5,
        lines: [
          "⠁ ⡠⠔⢣ ⠁  ⠁  ",
          "⠔⠊⣿⣿⠈⢆⠄  ⠄  ",
          "⣿⣿⣿⣿⣿⠘⡄    ⡠",
          "⣿⣿⣿⣿⣿⣿⠱⡀ ⢠⠊⣿",
          "⣿⣿⣿⣿⣿⣿⣿⢣⠔⠁⣿⣿",
        ],
        timeLabels: "Jan 2  Jan 5",
      },
      {
        mode: "line",
        width: 12,
        height: 5,
        lines: [
          "⠁ ⡠⠔⢣ ⠁  ⠁  ",
          "⠔⠊ ⠄⠈⢆⠄  ⠄  ",
          "     ⠘⡄    ⡠",
          "⠂  ⠂  ⠱⡀ ⢠⠊ ",
          "⡀  ⡀  ⡀⢣⠔⠁  ",
        ],
        timeLabels: "Jan 2  Jan 5",
      },
      {
        mode: "candles",
        width: 40,
        height: 6,
        lines: [
          "⠁  ⠁  ⠁  ⠁  ⠁ ⡇⠁  ⠁  ⠁  ⠁⢠ ⠁  ⠁  ⠁  ⠁  ⠁",
          "  ⢰        ⢰⣶⣶⣷⣶⣶      ⣶⣶⣾⣶⣶⡆           ",
          "⣶⣶⣾⣶⣶⡆⠁  ⠁ ⠘⠛⠛⡟⠛⠛ ⠁  ⠁ ⣿⣿⣿⣿⣿⡇ ⠁  ⠁  ⠁⡆ ⠁",
          "⠿⠿⢿⠿⠿⠇⡀  ⡀  ⡀ ⠇⡀  ⡀  ⡀ ⣿⣿⣿⣿⣿⡇ ⡀  ⡀⢸⣿⣿⣿⣿⣿",
          "  ⠸                    ⠿⠿⢿⠿⠿⠇     ⠸⠿⠿⡿⠿⠿",
          "⡀  ⡀  ⡀  ⡀  ⡀  ⡀  ⡀  ⡀  ⡀⢸ ⡀  ⡀  ⡀  ⡀⠃ ⡀",
        ],
        timeLabels: "Jan 2        3            4        Jan 5",
      },
      {
        mode: "ohlc",
        width: 28,
        height: 6,
        lines: [
          "⠁  ⠁  ⠁  ⢸⣿ ⠁  ⠁ ⣤⡄  ⠁  ⠁  ⠁",
          " ⢰⣶      ⢸⣿⠒⠂  ⠐⠒⣿⡇         ",
          "⠁⢸⣿⠒⠂ ⠁ ⠒⢺⣿ ⠁  ⠁ ⣿⡇  ⠁  ⠁⣶⡆⠁",
          "⠤⢼⣿⡀  ⡀  ⠸⠿ ⡀  ⡀ ⣿⡇  ⡀  ⡀⣿⡏⠉",
          " ⠸⠿              ⣿⡧⠤   ⠠⠤⣿⡇ ",
          "⡀  ⡀  ⡀  ⡀  ⡀  ⡀ ⣿⡇  ⡀  ⡀⠛⠃⡀",
        ],
        timeLabels: "Jan 2    3        4    Jan 5",
      },
      {
        mode: "hlc",
        width: 28,
        height: 6,
        lines: [
          "⠁  ⠁  ⠁  ⢸⣿ ⠁  ⠁ ⣤⡄  ⠁  ⠁  ⠁",
          " ⢰⣶      ⢸⣿⠒⠂    ⣿⡇         ",
          "⠁⢸⣿⠒⠂ ⠁  ⢸⣿ ⠁  ⠁ ⣿⡇  ⠁  ⠁⣶⡆⠁",
          "⡀⢸⣿⡀  ⡀  ⠸⠿ ⡀  ⡀ ⣿⡇  ⡀  ⡀⣿⡏⠉",
          " ⠸⠿              ⣿⡧⠤     ⣿⡇ ",
          "⡀  ⡀  ⡀  ⡀  ⡀  ⡀ ⣿⡇  ⡀  ⡀⠛⠃⡀",
        ],
        timeLabels: "Jan 2    3        4    Jan 5",
      },
    ];

    for (const testCase of cases) {
      const projection = projectChartData(chartFixture, testCase.width, testCase.mode, false);
      const result = renderChart(projection.points, {
        width: testCase.width,
        height: testCase.height,
        showVolume: false,
        volumeHeight: 0,
        cursorX: null,
        cursorY: null,
        mode: projection.effectiveMode,
        colors: palette,
      });

      expect(textLines(result)).toEqual(testCase.lines);
      expect(result.timeLabels).toBe(testCase.timeLabels);
    }
  });

  test("formats y-axis labels as percent change when requested", () => {
    const projection = projectChartData(chartFixture, 12, "line", false);
    const result = renderChart(projection.points, {
      width: 12,
      height: 5,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      axisMode: "percent",
      colors: palette,
    });

    expect(result.axisLabels).toEqual([
      { row: 0, label: "+9.09%" },
      { row: 1, label: "0.00%" },
      { row: 3, label: "-9.09%" },
      { row: 4, label: "-18.2%" },
    ]);
  });

  test("uses the supplied currency for rendered price-axis labels", () => {
    const projection = projectChartData(chartFixture, 12, "line", false);
    const result = renderChart(projection.points, {
      width: 12,
      height: 5,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      axisMode: "price",
      currency: "JPY",
      colors: palette,
    });

    expect(result.axisLabels.some((entry) => entry.label.includes("¥"))).toBe(true);
    expect(result.axisLabels.every((entry) => !entry.label.includes("$"))).toBe(true);
  });

  test("accepts serialized string dates from cached chart data", () => {
    const serialized = chartFixture.map((point) => ({
      ...point,
      date: point.date.toISOString(),
    })) as unknown as PricePoint[];

    const projection = projectChartData(serialized, 12, "area", false);
    const result = renderChart(projection.points, {
      width: 12,
      height: 5,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: projection.effectiveMode,
      colors: palette,
    });

    expect(projection.points[0]?.date instanceof Date).toBe(true);
    expect(result.timeLabels).toBe("Jan 2  Jan 5");
  });
});
