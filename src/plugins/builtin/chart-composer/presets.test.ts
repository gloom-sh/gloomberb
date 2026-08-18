import { describe, expect, test } from "bun:test";
import {
  canToggleChartSeries,
  parseChartSpec,
  projectVisibleChartSeries,
  serializeChartSpec,
  toggleChartSeries,
} from "./chart-spec";
import {
  appendChartSeries,
  buildComparisonChartPreset,
  buildCustomChartPreset,
  buildFundamentalChartPreset,
  buildIntradayPriceChartPreset,
  buildPriceChartPreset,
  buildSeriesSpec,
  applySeriesStyle,
  applySeriesTimestampMode,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  formatSeriesExpression,
  parseChartExpression,
  parseSeriesExpression,
  rebindChartSecuritySymbol,
  resolveChartFieldAlias,
  setBuiltinStudies,
  setPairStudies,
} from "./presets";
import { applyChartComposerCapabilityOptions } from "./cli-options";

describe("chart composer expressions", () => {
  test("round-trips provider-neutral capability expressions and parameters", () => {
    const expression = {
      kind: "capability" as const,
      capabilityId: "prediction-markets.series",
      seriesId: "polymarket:one",
      parameters: { outcome: "yes", nested: { token: "123" } },
      label: "Will it happen?",
    };
    const series = buildSeriesSpec(expression, 0);
    expect(parseSeriesExpression(formatSeriesExpression(series))).toEqual({
      kind: "capability",
      capabilityId: expression.capabilityId,
      seriesId: expression.seriesId,
      parameters: expression.parameters,
    });
  });

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

  test("accepts catalog aliases and FRED series in one expression", () => {
    expect(parseChartExpression(
      "aapl:price; msft:Free Cash Flow Margin\nFRED:CPIAUCSL",
    )).toEqual([
      { kind: "security", symbol: "AAPL", fieldId: "market.ohlcv" },
      { kind: "security", symbol: "MSFT", fieldId: "fundamental.freeCashFlowMargin" },
      { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
    ]);
    expect(resolveChartFieldAlias("EV / EBITDA")).toBe("valuation.evEbitda");
  });

  test("rejects an invalid leg instead of silently building a partial chart", () => {
    expect(() => buildCustomChartPreset("AAPL:price, MSFT:revenu"))
      .toThrow('Invalid chart series "MSFT:revenu"');
  });

  test("parses exchange-qualified tickers without confusing the exchange for a field", () => {
    const spec = buildCustomChartPreset("3hnx:lse, 3HNX:LSE:revenue");

    expect(spec.series.map((series) => series.source)).toEqual([
      expect.objectContaining({
        kind: "security",
        instrument: { symbol: "3HNX", exchange: "LSE" },
        fieldId: "market.ohlcv",
      }),
      expect.objectContaining({
        kind: "security",
        instrument: { symbol: "3HNX", exchange: "LSE" },
        fieldId: "fundamental.totalRevenue",
      }),
    ]);
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
});

describe("chart composer presets and formulas", () => {
  test("keeps shortcut presets semantically distinct", () => {
    const intraday = buildIntradayPriceChartPreset("aapl");
    expect(intraday.viewport).toEqual({ range: "1D", resolution: "1m" });
    expect(intraday.series[0]).toMatchObject({ style: "candles", transform: "raw" });
    expect(getSelectedBuiltinStudies(intraday)).toEqual(["volume"]);

    const comparison = buildComparisonChartPreset(["aapl", "msft"]);
    expect(comparison.series.map((series) => ({ style: series.style, transform: series.transform }))).toEqual([
      { style: "line", transform: "percent" },
      { style: "line", transform: "percent" },
    ]);

    const fundamental = buildFundamentalChartPreset(["aapl"]);
    expect(fundamental.series[0]).toMatchObject({
      style: "columns",
      interpolation: "none",
      source: { fieldId: "fundamental.totalRevenue", timestampMode: "period-end" },
    });
  });

  test("keeps one visible base series and projects visibility without waiting for data reload", () => {
    const spec = buildComparisonChartPreset(["AAPL", "MSFT"]);
    const resolved = spec.series.map((series, index) => ({
      id: series.id,
      label: series.id,
      color: index === 0 ? "#fff" : "#aaa",
      unit: "USD",
      unitGroup: "price",
      nativeFrequency: "daily" as const,
      dataShape: "scalar" as const,
      style: series.style,
      transform: series.transform,
      axis: "left" as const,
      panelId: series.panelId,
      interpolation: series.interpolation,
      points: [],
    }));

    const withHiddenSecond = toggleChartSeries(spec, spec.series[1]!.id);
    expect(withHiddenSecond.series[1]?.visible).toBe(false);
    expect(projectVisibleChartSeries(withHiddenSecond, resolved).map((series) => series.id))
      .toEqual([spec.series[0]!.id]);
    expect(canToggleChartSeries(withHiddenSecond, spec.series[0]!.id)).toBe(false);
    expect(toggleChartSeries(withHiddenSecond, spec.series[0]!.id)).toBe(withHiddenSecond);

    const restored = toggleChartSeries(withHiddenSecond, spec.series[1]!.id);
    expect(projectVisibleChartSeries(restored, [], resolved).map((series) => series.id))
      .toEqual(spec.series.map((series) => series.id));
  });

  test("includes volume in fresh price and followed-ticker defaults", () => {
    const price = buildPriceChartPreset("AAPL");
    const followed = buildCustomChartPreset("", "AAPL");

    expect(getSelectedBuiltinStudies(price)).toEqual(["volume"]);
    expect(price.panels.find((panel) => panel.id === "volume")).toMatchObject({
      label: "Volume",
      height: 0.24,
    });
    expect(followed).toEqual(price);
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

  test("binds pair formulas to the first two visible series after reordering", () => {
    const comparison = buildComparisonChartPreset(["AAPL", "MSFT", "NVDA"]);
    const withFormulas = setPairStudies(comparison, ["ratio", "correlation"]);
    const firstInputs = withFormulas.series.slice(0, 2).map((series) => series.id);
    expect(withFormulas.studies.map((study) => study.inputSeriesIds)).toEqual([
      firstInputs,
      firstInputs,
    ]);

    const reordered = {
      ...withFormulas,
      series: [withFormulas.series[2]!, withFormulas.series[0]!, withFormulas.series[1]!],
    };
    const rebound = setPairStudies(reordered, getSelectedPairStudies(reordered));
    const reorderedInputs = rebound.series.slice(0, 2).map((series) => series.id);
    expect(rebound.studies.map((study) => study.inputSeriesIds)).toEqual([
      reorderedInputs,
      reorderedInputs,
    ]);
  });

  test("preserves user-authored panel settings when indicators and formulas change", () => {
    const comparison = buildComparisonChartPreset(["AAPL", "MSFT"]);
    const customized = {
      ...comparison,
      panels: [
        { id: "main", label: "Relative performance", height: 0.72, scale: "log" as const },
        { id: "notes", label: "Reserved", height: 0.4 },
      ],
    };

    const withIndicators = setBuiltinStudies(customized, ["rsi14"]);
    expect(getSelectedBuiltinStudies(withIndicators)).toEqual(["rsi14"]);
    expect(withIndicators.panels[0]).toEqual({
      id: "main",
      label: "Relative performance",
      height: 0.72,
      scale: "log",
    });
    expect(withIndicators.panels.find((panel) => panel.id === "rsi")).toMatchObject({
      label: "RSI",
      height: 0.28,
    });
    expect(withIndicators.panels).toContainEqual({
      id: "notes",
      label: "Reserved",
      height: 0.4,
    });

    const withFormula = setPairStudies(withIndicators, ["ratio"]);
    expect(withFormula.panels[0]).toEqual(withIndicators.panels[0]);
    expect(withFormula.panels.find((panel) => panel.id === "rsi")).toEqual(
      withIndicators.panels.find((panel) => panel.id === "rsi"),
    );

    const customizedFormula = {
      ...withFormula,
      panels: withFormula.panels.map((panel) => panel.id === "formula"
        ? { ...panel, label: "Custom ratio", height: 0.41, scale: "log" as const }
        : panel),
    };
    const rebound = setPairStudies(customizedFormula, getSelectedPairStudies(customizedFormula));
    expect(rebound.panels.find((panel) => panel.id === "formula")).toEqual({
      id: "formula",
      label: "Custom ratio",
      height: 0.41,
      scale: "log",
    });

    const withoutManagedStudies = setPairStudies(setBuiltinStudies(rebound, []), []);
    expect(withoutManagedStudies.panels.some((panel) => panel.id === "rsi")).toBe(false);
    expect(withoutManagedStudies.panels.some((panel) => panel.id === "formula")).toBe(false);
    expect(withoutManagedStudies.panels).toContainEqual({
      id: "notes",
      label: "Reserved",
      height: 0.4,
    });
  });
});

describe("chart composer spec persistence", () => {
  test("normalizes aliases and incompatible presentation on parse", () => {
    const authored = buildCustomChartPreset("MSFT:revenue");
    const series = authored.series[0]!;
    const parsed = parseChartSpec({
      ...authored,
      series: [{
        ...series,
        source: { ...series.source, fieldId: "revenue" },
        style: "candles",
      }],
    });

    expect(parsed?.series[0]).toMatchObject({
      style: "columns",
      source: { kind: "security", fieldId: "fundamental.totalRevenue" },
    });
    expect(parsed?.panels[0]?.scale).toBe("linear");
  });

  test("round-trips a valid spec and rejects malformed semantic references", () => {
    const valid = setPairStudies(
      buildComparisonChartPreset(["AAPL", "MSFT"]),
      ["spread"],
    );
    expect(parseChartSpec(serializeChartSpec(valid))).toEqual(parseChartSpec(valid));
    expect(parseChartSpec("not json")).toBeNull();

    const price = buildPriceChartPreset("AAPL");
    expect(parseChartSpec({
      ...price,
      panels: [...price.panels, { id: "formula" }],
      studies: [{
        id: "bad-ratio",
        kind: "ratio",
        inputSeriesIds: [price.series[0]!.id],
        parameters: {},
        panelId: "formula",
        axis: "auto",
      }],
    })).toBeNull();
  });

  test("round-trips independent financial style and timing choices", () => {
    const base = buildCustomChartPreset("AAPL:revenue, MSFT:revenue");
    const authored = {
      ...base,
      series: [
        applySeriesStyle(base.series[0]!, "line"),
        applySeriesTimestampMode(
          applySeriesStyle(base.series[1]!, "columns"),
          "available-at",
        ),
      ],
    };

    const parsed = parseChartSpec(serializeChartSpec(authored));
    expect(parsed?.series.map((series) => ({
      style: series.style,
      timestampMode: series.source.kind === "security" ? series.source.timestampMode : undefined,
    }))).toEqual([
      { style: "line", timestampMode: "period-end" },
      { style: "columns", timestampMode: "available-at" },
    ]);
  });

  test("rejects chart specs authored by a newer unsupported version", () => {
    const current = buildPriceChartPreset("AAPL");
    expect(parseChartSpec({ ...current, version: current.version + 1 })).toBeNull();
    expect(parseChartSpec({ ...current, version: String(current.version + 1) })).toBeNull();
  });
});

describe("chart composer CLI options", () => {
  test("applies price and financial options to the persisted spec", () => {
    const candle = applyChartComposerCapabilityOptions(
      buildPriceChartPreset("AAPL"),
      "price-chart",
      { axisMode: "percent" },
    );
    expect(candle.series[0]).toMatchObject({ style: "candles", transform: "raw" });

    const comparison = applyChartComposerCapabilityOptions(
      buildComparisonChartPreset(["AAPL", "MSFT"]),
      "price-comparison",
      { rangePreset: "3M", chartResolution: "1h", axisMode: "price" },
    );
    expect(comparison.viewport).toMatchObject({ range: "3M", resolution: "1h" });
    expect(comparison.series.every((series) => series.transform === "raw")).toBe(true);

    const initialFinancial = buildCustomChartPreset("AAPL:revenue");
    const financial = applyChartComposerCapabilityOptions(
      {
        ...initialFinancial,
        series: [
          applySeriesTimestampMode(initialFinancial.series[0]!, "available-at"),
        ],
      },
      "fundamental-series",
      { metric: "freeCashFlow", period: "annual", periods: 6 },
    );
    expect(financial.viewport.maxPoints).toBe(6);
    expect(financial.series[0]?.source).toMatchObject({
      kind: "security",
      fieldId: "fundamental.freeCashFlow",
      period: "annual",
      timestampMode: "available-at",
    });
  });
});
