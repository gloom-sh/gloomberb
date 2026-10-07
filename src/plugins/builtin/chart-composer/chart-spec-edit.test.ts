import { describe, expect, test } from "bun:test";
import { parseChartSpec } from "./chart-spec";
import {
  appendChartSeries,
  applySeriesStyle,
  applySeriesTimestampMode,
  buildSeriesSpec,
  rebindChartSecuritySymbol,
  rebindResearchChartSpec,
} from "./chart-spec-edit";
import { setBuiltinStudies } from "./studies";
import {
  buildComparisonChartPreset,
  buildCustomChartPreset,
  buildFundamentalChartPreset,
  buildPriceChartPreset,
} from "./presets";

describe("chart composer series placement", () => {
  test("appends catalog series with required panels and collision-safe IDs", () => {
    const initial = buildCustomChartPreset("AAPL:price, MSFT:price");
    const withVolume = appendChartSeries(initial, {
      kind: "security",
      symbol: "AAPL",
      fieldId: "market.volume",
    });
    expect(withVolume.spec.panels.some((panel) => panel.id === "volume")).toBe(true);

    const repeated = buildCustomChartPreset("AAPL:price, AAPL:price, AAPL:price");
    const withRemovedMiddle = {
      ...repeated,
      series: [repeated.series[0]!, repeated.series[2]!],
    };
    const appended = appendChartSeries(withRemovedMiddle, {
      kind: "security",
      symbol: "AAPL",
      fieldId: "market.ohlcv",
    });

    expect(appended.spec.series.map((series) => series.id)).toEqual([
      "aapl-market-ohlcv-1",
      "aapl-market-ohlcv-3",
      "aapl-market-ohlcv-3-2",
    ]);
  });

  test("places appended financial data in a synchronized panel without rewriting authored state", () => {
    const price = buildPriceChartPreset("AAPL");
    const authored = {
      ...price,
      viewport: { ...price.viewport, range: "3M" as const },
      panels: [...price.panels, { id: "notes", label: "Reserved", height: 0.4 }],
    };
    const appended = appendChartSeries(authored, {
      kind: "security",
      symbol: "MSFT",
      fieldId: "fundamental.totalRevenue",
    });

    expect(appended.spec.viewport).toEqual(authored.viewport);
    expect(appended.spec.studies).toEqual(authored.studies);
    expect(appended.spec.series[0]).toEqual(authored.series[0]);
    expect(appended.spec.panels.slice(0, authored.panels.length)).toEqual(authored.panels);
    expect(appended.series).toMatchObject({
      style: "columns",
      panelId: "fundamentals",
      source: { timestampMode: "available-at" },
    });
    expect(appended.spec.panels.find((panel) => panel.id === "fundamentals")).toMatchObject({
      label: "Fundamentals",
      height: 0.35,
    });
  });

  test("places only the new candidate when incremental axes or panel scopes overflow", () => {
    const fundamentals = buildFundamentalChartPreset(["AAPL"]);
    const withPrice = appendChartSeries(fundamentals, {
      kind: "security",
      symbol: "AAPL",
      fieldId: "market.ohlcv",
    });
    expect(withPrice.spec.series[0]).toEqual(fundamentals.series[0]);
    expect(withPrice.series.panelId).toBe("panel-2");

    const price = buildPriceChartPreset("AAPL");
    const withCpi = appendChartSeries(price, {
      kind: "economic",
      provider: "fred",
      seriesId: "CPIAUCSL",
    }).spec;
    const withRates = appendChartSeries(withCpi, {
      kind: "economic",
      provider: "fred",
      seriesId: "UNRATE",
    });
    expect(withRates.spec.series.slice(0, 2).map((series) => series.panelId))
      .toEqual(["main", "main"]);
    expect(withRates.series.panelId).toBe("panel-2");
    expect(withRates.spec.panels.find((panel) => panel.id === "panel-2")).toMatchObject({
      label: "Panel 2",
      height: 0.35,
    });
  });

  test("renders an appended secondary OHLCV price as a valid comparison line", () => {
    const initial = buildPriceChartPreset("AAPL");
    const appended = appendChartSeries(initial, {
      kind: "security",
      symbol: "META",
      fieldId: "market.ohlcv",
    });

    expect(initial.series[0]).toMatchObject({ style: "candles", panelId: "main" });
    expect(appended.series).toMatchObject({
      source: {
        kind: "security",
        instrument: { symbol: "META" },
        fieldId: "market.ohlcv",
      },
      style: "line",
      transform: "raw",
      interpolation: "none",
      panelId: "main",
    });
    expect(parseChartSpec(appended.spec)).not.toBeNull();
  });

  test("keeps bulk custom price expressions valid with one OHLC presentation per panel", () => {
    const spec = buildCustomChartPreset("AAPL:price, META:price");

    expect(spec.series.map(({ style, transform, interpolation }) => ({
      style,
      transform,
      interpolation,
    }))).toEqual([
      { style: "candles", transform: "raw", interpolation: "none" },
      { style: "line", transform: "raw", interpolation: "none" },
    ]);
    expect(parseChartSpec(spec)).not.toBeNull();
  });

  test("builds mixed-frequency series with source-appropriate presentation", () => {
    const spec = buildCustomChartPreset("AAPL:price, MSFT:revenue, FRED:CPIAUCSL");

    expect(spec.series.map((series) => series.source.kind)).toEqual([
      "security",
      "security",
      "economic",
    ]);
    expect(spec.series[0]).toMatchObject({ style: "candles", interpolation: "none" });
    expect(spec.series[1]).toMatchObject({
      style: "columns",
      interpolation: "none",
      panelId: "fundamentals",
      source: {
        kind: "security",
        fieldId: "fundamental.totalRevenue",
        period: "quarterly",
        timestampMode: "available-at",
      },
    });
    expect(spec.series[2]).toMatchObject({
      style: "step",
      interpolation: "step-after",
      panelId: "panel-2",
      source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
    });
    expect(spec.panels.find((panel) => panel.id === "panel-2")).toMatchObject({
      label: "Panel 2",
      height: 0.35,
    });
    expect(spec.panels.find((panel) => panel.id === "fundamentals")).toMatchObject({
      label: "Fundamentals",
      height: 0.35,
    });

    const reversed = buildCustomChartPreset("MSFT:revenue, AAPL:price");
    const price = reversed.series.find((series) => (
      series.source.kind === "security" && series.source.fieldId === "market.ohlcv"
    ));
    const revenue = reversed.series.find((series) => (
      series.source.kind === "security" && series.source.fieldId === "fundamental.totalRevenue"
    ));
    expect(price?.panelId).toBe("main");
    expect(revenue).toMatchObject({
      panelId: "fundamentals",
      style: "columns",
      source: { timestampMode: "available-at" },
    });

    expect(buildCustomChartPreset("AAPL:revenue, MSFT:revenue").series.map((series) => series.axis))
      .toEqual(["auto", "auto"]);
  });

  test("keeps interpolation consistent with an overridden series style", () => {
    expect(buildSeriesSpec(
      { kind: "security", symbol: "AAPL", fieldId: "fundamental.totalRevenue" },
      0,
      { style: "columns", interpolation: "step-after" },
    )).toMatchObject({
      style: "columns",
      interpolation: "none",
      source: { timestampMode: "period-end" },
    });
    expect(buildSeriesSpec(
      { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
      0,
      { style: "line", interpolation: "step-after" },
    )).toMatchObject({
      style: "line",
      interpolation: "none",
    });
  });

  test("forces raw values when a series changes to an OHLC presentation", () => {
    const price = buildPriceChartPreset("AAPL").series[0]!;
    const transformed = { ...price, style: "line" as const, transform: "percent" as const };
    expect(applySeriesStyle(transformed, "candles")).toMatchObject({
      style: "candles",
      transform: "raw",
    });
  });

  test("keeps financial timing independent from visual style", () => {
    const revenue = buildCustomChartPreset("AAPL:revenue").series[0]!;
    const line = applySeriesStyle(revenue, "line");
    const available = applySeriesTimestampMode(revenue, "available-at");
    const columns = applySeriesStyle(available, "columns");

    expect(line.interpolation).toBe("none");
    expect(line.source).toMatchObject({ timestampMode: "period-end" });
    expect(columns.interpolation).toBe("none");
    expect(columns.source).toMatchObject({ timestampMode: "available-at" });
    expect(applySeriesStyle(columns, "line")).toMatchObject({
      interpolation: "none",
      source: {
        timestampMode: "available-at",
      },
    });
  });
});

describe("chart composer research rebinding", () => {
  test("rebinds followed research symbols without resetting authored chart state", () => {
    const price = buildPriceChartPreset("AAPL");
    const customized = setBuiltinStudies({
      ...price,
      viewport: { range: "3M", resolution: "1h" },
      series: [
        { ...price.series[0]!, style: "line", transform: "percent", label: "AAPL" },
        buildCustomChartPreset("MSFT:revenue").series[0]!,
      ],
    }, ["sma20"]);

    const rebound = rebindChartSecuritySymbol(customized, "AAPL", "NVDA");
    expect(rebound.viewport).toEqual(customized.viewport);
    expect(rebound.studies).toEqual(customized.studies);
    expect(rebound.series[0]).toMatchObject({
      style: "line",
      transform: "percent",
      label: "NVDA",
      source: { instrument: { symbol: "NVDA" } },
    });
    expect(rebound.series[1]).toEqual(customized.series[1]);
  });

  test("research follows the exact listing while preserving other venues and authored chart state", () => {
    for (const [previous, next, exchange] of [["ASML:XAMS", "ASML:NASDAQ", "NASDAQ"], ["ASML:XNAS", "ASML:AMS", "AMS"]]) {
      const comparison = buildComparisonChartPreset([previous!, next!, "SPY:ARCX"]);
      const customized = setBuiltinStudies({ ...comparison,
        viewport: { range: "3M", resolution: "1h" },
        series: comparison.series.map((entry, index) => ({ ...entry, label: index === 0 ? "My primary listing" : entry.label })),
      }, ["sma20"]);
      const rebound = rebindResearchChartSpec(customized, previous!, next!);
      expect(rebound.series[0]).toMatchObject({ id: customized.series[0]!.id, label: "My primary listing", transform: "percent",
        source: { instrument: { symbol: "ASML", exchange } } });
      expect(rebound.series.slice(1)).toEqual(customized.series.slice(1));
      expect(rebound.viewport).toEqual(customized.viewport);
      expect(rebound.panels).toEqual(customized.panels);
      expect(rebound.studies).toEqual(customized.studies);
    }
  });

  test("research repairs a persisted qualified primary once and keeps equivalent aliases unchanged", () => {
    const stored = buildPriceChartPreset("ASML:XAMS");
    const restored = rebindResearchChartSpec(stored, "ASML:XNAS", "ASML:XNAS");
    expect(restored.series[0]?.source).toMatchObject({ instrument: { symbol: "ASML", exchange: "NASDAQ" } });
    expect(rebindResearchChartSpec(restored, "ASML:XNAS", "ASML:NASDAQ")).toBe(restored);
    expect(rebindResearchChartSpec(stored, "ASML:XAMS", "ASML:AMS")).toBe(stored);
    const labelled = { ...stored, series: stored.series.map((entry) => ({ ...entry, label: "ASML:XAMS" })) };
    expect(rebindResearchChartSpec(labelled, "ASML:AMS", "ASML:XNAS").series[0]?.label).toBe("ASML:XNAS");
  });

  test("a restored target or economic-only chart does not replace unrelated comparisons", () => {
    const comparison = buildComparisonChartPreset(["SPY:ARCX", "ASML:XNAS"]);
    expect(rebindResearchChartSpec(comparison, "ASML:XAMS", "ASML:NASDAQ")).toBe(comparison);
    const economic = buildCustomChartPreset("FRED:CPIAUCSL");
    expect(rebindResearchChartSpec(economic, "ASML:XAMS", "ASML:XNAS")).toBe(economic);
  });
});
