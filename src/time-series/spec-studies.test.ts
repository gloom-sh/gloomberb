import { describe, expect, test } from "bun:test";
import { getTimeSeriesField } from "./field-catalog";
import { normalizeChartSpec, validateChartSpec } from "./spec";
import { maxStudyWarmupPoints, resolveStudies } from "./studies";
import { applyResolvedSeriesTransform } from "./transforms";
import type { ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "./types";

function resolved(id: string, multiplier = 1): ResolvedSeries {
  const points: TimeSeriesPoint[] = Array.from({ length: 60 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, index + 1));
    return {
      date,
      observedAt: date,
      availableAt: date,
      value: (index + 1) * multiplier,
      close: (index + 1) * multiplier,
      volume: 1_000 + index,
    };
  });
  return {
    id,
    label: id.toUpperCase(),
    color: "#fff",
    unit: "USD/share",
    unitGroup: "price",
    volumeUnit: "shares",
    nativeFrequency: "daily",
    dataShape: "ohlcv",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points,
  };
}

function study(
  id: string,
  kind: ChartStudySpec["kind"],
  inputs: string[],
  parameters: Record<string, number> = {},
): ChartStudySpec {
  return { id, kind, inputSeriesIds: inputs, parameters, panelId: "study", axis: "auto" };
}

describe("chart spec normalization and validation", () => {
  test("canonicalizes field aliases and replaces an incompatible style", () => {
    const normalized = normalizeChartSpec({
      viewport: { range: "5Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "revenue",
        source: {
          kind: "security",
          instrument: { symbol: "msft" },
          fieldId: "revenue",
          period: "quarterly",
        },
        style: "candles",
        transform: "raw",
        panelId: "main",
      }],
      studies: [],
    });
    expect(normalized.series[0]?.source.kind).toBe("security");
    if (normalized.series[0]?.source.kind !== "security") throw new Error("expected security source");
    expect(normalized.series[0].source.fieldId).toBe("fundamental.totalRevenue");
    expect(normalized.series[0].source.instrument.symbol).toBe("MSFT");
    expect(normalized.series[0].style).toBe("columns");
    expect(validateChartSpec(normalized).valid).toBe(true);
  });

  test("persists and clones bounded opaque capability sources without requiring the provider", () => {
    const normalized = normalizeChartSpec({
      viewport: { range: "1M", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "plugin-series",
        source: {
          kind: "capability",
          capabilityId: "missing.provider",
          seriesId: "polymarket/event-1/market-1",
        },
        style: "area",
        transform: "raw",
        panelId: "main",
      }],
      studies: [],
    });
    const cloned = normalizeChartSpec(normalized);
    expect(cloned.series[0]?.source).toEqual(normalized.series[0]?.source);
    expect(cloned.series[0]?.source).not.toBe(normalized.series[0]?.source);
    expect(validateChartSpec(cloned).valid).toBe(true);
  });

  test("coerces OHLC modes away from scalar economic series", () => {
    const normalized = normalizeChartSpec({
      viewport: { range: "1Y", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "cpi",
        source: { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
        style: "candles",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "step-after",
      }],
      studies: [],
    });

    expect(normalized.series[0]?.style).toBe("step");
    expect(validateChartSpec(normalized).valid).toBe(true);
  });

  test("preserves explicit financial timing and migrates legacy timing once", () => {
    const authored = {
      viewport: { range: "1Y", resolution: "auto" },
      panels: [{ id: "main" }],
      series: [{
        id: "revenue",
        source: {
          kind: "security",
          instrument: { symbol: "AAPL" },
          fieldId: "fundamental.totalRevenue",
          period: "quarterly",
        },
        style: "columns",
        transform: "raw",
        axis: "right",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    } as const;

    const explicitColumns = normalizeChartSpec({
      ...authored,
      series: [{
        ...authored.series[0],
        source: { ...authored.series[0].source, timestampMode: "available-at" },
      }],
    });
    expect(explicitColumns.series[0]?.source).toMatchObject({
      kind: "security",
      timestampMode: "available-at",
    });

    const explicitLine = normalizeChartSpec({
      ...authored,
      series: [{
        ...authored.series[0],
        source: { ...authored.series[0].source, timestampMode: "period-end" },
        style: "line",
        interpolation: "step-after",
      }],
    });
    expect(explicitLine.series[0]).toMatchObject({
      style: "line",
      interpolation: "none",
      source: {
        kind: "security",
        timestampMode: "period-end",
      },
    });

    expect(normalizeChartSpec(authored).series[0]?.source)
      .toMatchObject({ timestampMode: "period-end" });
    expect(normalizeChartSpec({
      ...authored,
      series: [{ ...authored.series[0], style: "line" }],
    }).series[0]?.source).toMatchObject({ timestampMode: "available-at" });
  });

  test("rejects annual QoQ, duplicate OHLC series, and missing study inputs", () => {
    const normalized = normalizeChartSpec({
      viewport: { range: "5Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: ["a", "b"].map((id) => ({
        id,
        source: { kind: "security", instrument: { symbol: id }, fieldId: "market.ohlcv", period: "annual" },
        style: "candles",
        transform: "raw",
        axis: "auto",
        panelId: "main",
        interpolation: "none",
      })),
      studies: [study("ratio", "ratio", ["a", "missing"])],
    });
    normalized.series[0]!.transform = "qoq";
    const result = validateChartSpec(normalized);
    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code }) => code)).toContain("qoq-annual");
    expect(result.errors.map(({ code }) => code)).toContain("multiple-ohlc");
    // The blocking series is usually hidden or drawn as a line for lack of OHLC
    // data, so the message has to name it or it reads as a phantom conflict.
    expect(result.errors.find(({ code }) => code === "multiple-ohlc")?.message)
      .toBe("A already uses a candle or OHLC style on main. Give it another style first.");
    expect(result.errors.map(({ code }) => code)).toContain("missing-input");
  });

  test("rejects applying logarithms twice", () => {
    const normalized = normalizeChartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main", scale: "log" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "AAPL" }, fieldId: "market.close" },
        style: "line",
        transform: "log",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    });

    expect(validateChartSpec(normalized).errors.map(({ code }) => code)).toContain("double-log");
  });

  test("rejects periods that a source cannot represent", () => {
    const price = normalizeChartSpec({
      viewport: { range: "1Y", resolution: "1d" },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: { kind: "security", instrument: { symbol: "AAPL" }, fieldId: "market.close", period: "ttm" },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    });
    expect(validateChartSpec(price).errors.map(({ code }) => code)).toContain("unsupported-period");
  });

  test("rejects a manual viewport interval coarser than an explicit market period", () => {
    const marketSpec = (
      period: "daily" | "weekly" | "monthly",
      resolution: "auto" | "1d" | "1wk" | "1mo",
    ) => normalizeChartSpec({
      viewport: { range: "ALL", resolution },
      panels: [{ id: "main" }],
      series: [{
        id: "price",
        source: {
          kind: "security",
          instrument: { symbol: "AAPL" },
          fieldId: "market.close",
          period,
        },
        style: "line",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
      }],
      studies: [],
    });

    const daily = validateChartSpec(marketSpec("daily", "1wk"));
    const dailyIssue = daily.errors.find(({ code }) => code === "market-period-resolution");
    expect(dailyIssue?.path).toBe("series.0.source.period");
    expect(dailyIssue?.message).toContain("Choose Auto or 1D (or finer)");

    const weekly = validateChartSpec(marketSpec("weekly", "1mo"));
    expect(weekly.errors.find(({ code }) => code === "market-period-resolution")?.message)
      .toContain("Choose Auto or 1W (or finer)");

    expect(validateChartSpec(marketSpec("weekly", "1d")).valid).toBe(true);
    expect(validateChartSpec(marketSpec("daily", "auto")).valid).toBe(true);
  });

  test("catalog exposes OHLCV, existing fundamentals, and valuation fields", () => {
    expect(getTimeSeriesField("market.ohlcv")?.dataShape).toBe("ohlcv");
    expect(getTimeSeriesField("income.revenue")?.id).toBe("fundamental.totalRevenue");
    expect(getTimeSeriesField("valuation.evEbitda")?.unitGroup).toBe("multiple");
  });
});

describe("study resolution", () => {
  test("produces overlays, oscillators, bands, pair formulas, and rolling correlation", () => {
    const specs = [
      study("sma", "sma", ["a"], { period: 5 }),
      study("ema", "ema", ["a"], { period: 5 }),
      study("bb", "bollinger", ["a"], { period: 5, stdDev: 2 }),
      study("rsi", "rsi", ["a"], { period: 14 }),
      study("macd", "macd", ["a"], { fast: 12, slow: 26, signal: 9 }),
      study("volume", "volume", ["a"]),
      study("ratio", "ratio", ["a", "b"]),
      study("spread", "spread", ["a", "b"], { multiplier: 0.5 }),
      study("correlation", "correlation", ["a", "b"], { period: 10 }),
    ];
    const result = resolveStudies([resolved("a"), resolved("b", 2)], specs);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.series.find(({ id }) => id === "sma")?.points[0]?.value).toBe(3);
    expect(result.series.filter(({ id }) => id.startsWith("bb:"))).toHaveLength(3);
    expect(result.series.find(({ id }) => id === "rsi")?.points.every(({ value }) => value === 100)).toBe(true);
    expect(result.series.find(({ id }) => id === "macd:histogram")?.style).toBe("columns");
    expect(result.series.find(({ id }) => id === "volume")?.points[0]?.value).toBe(1_000);
    expect(result.series.find(({ id }) => id === "ratio")?.points.every(({ value }) => value === 0.5)).toBe(true);
    expect(result.series.find(({ id }) => id === "spread")?.points.every(({ value }) => value === 0)).toBe(true);
    const correlations = result.series.find(({ id }) => id === "correlation")?.points ?? [];
    expect(correlations.length).toBeGreaterThan(0);
    expect(correlations.at(-1)?.value).toBeCloseTo(1, 10);
    expect(maxStudyWarmupPoints(specs)).toBe(33);
  });

  test("omits empty-volume noise while preserving analytical history warnings", () => {
    const input = resolved("a");
    input.points = input.points.map(({ volume: _volume, ...point }) => point);

    const result = resolveStudies([input], [
      study("volume", "volume", ["a"]),
      study("sma", "sma", ["a"], { period: 100 }),
    ]);

    expect(result.series.find(({ id }) => id === "volume")?.points).toEqual([]);
    expect(result.warnings).toEqual([
      "sma: not enough valid history to calculate sma.",
    ]);
  });

  test("adds no volume panel for an instrument that reports zero volume on every bar", () => {
    const input = resolved("a");
    input.points = input.points.map((point, index) => ({ ...point, volume: index === input.points.length - 1 ? undefined : 0 }));
    expect(resolveStudies([input], [study("volume", "volume", ["a"])]).series).toEqual([]);
  });

  test("aligns pair formulas to the latest available value even when display interpolation is off", () => {
    const point = (date: string, value: number): TimeSeriesPoint => {
      const availableAt = new Date(`${date}T00:00:00Z`);
      return {
        date: availableAt,
        observedAt: availableAt,
        availableAt,
        value,
      };
    };
    const left: ResolvedSeries = {
      ...resolved("left"),
      nativeFrequency: "quarterly",
      interpolation: "none",
      points: [
        point("2025-01-10", 10),
        point("2025-03-10", 20),
        point("2025-05-10", 30),
      ],
    };
    const right: ResolvedSeries = {
      ...resolved("right"),
      nativeFrequency: "quarterly",
      interpolation: "none",
      points: [
        point("2025-02-10", 2),
        point("2025-04-10", 4),
        point("2025-06-10", 6),
      ],
    };

    const result = resolveStudies([left, right], [
      study("ratio", "ratio", ["left", "right"]),
      study("spread", "spread", ["left", "right"]),
      study("correlation", "correlation", ["left", "right"], { period: 3, returns: 0 }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.series.find(({ id }) => id === "ratio")?.points.map((entry) => ({
      date: entry.date.toISOString().slice(0, 10),
      value: entry.value,
    }))).toEqual([
      { date: "2025-02-10", value: 5 },
      { date: "2025-03-10", value: 10 },
      { date: "2025-04-10", value: 5 },
      { date: "2025-05-10", value: 7.5 },
      { date: "2025-06-10", value: 5 },
    ]);
    expect(result.series.find(({ id }) => id === "ratio")).toMatchObject({
      style: "step",
      interpolation: "step-after",
    });
    expect(result.series.find(({ id }) => id === "spread")).toMatchObject({
      style: "step",
      interpolation: "step-after",
    });
    expect(result.series.find(({ id }) => id === "spread")?.points).toHaveLength(5);
    const correlation = result.series.find(({ id }) => id === "correlation")?.points ?? [];
    expect(correlation).toHaveLength(0);
    expect(result.warnings).toContain("correlation: not enough valid history to calculate correlation.");
    expect(result.series.find(({ id }) => id === "correlation")).toMatchObject({
      style: "line",
      interpolation: "none",
    });
  });

  test("correlates returns over shared observations without inventing closed-market zero returns", () => {
    const series = (id: string, rows: Array<[string, number | null]>): ResolvedSeries => ({
      ...resolved(id),
      points: rows.map(([day, value]) => ({ date: new Date(day), observedAt: new Date(day), value })),
    });
    // Stock closes Friday, then Tuesday after a holiday. Crypto also trades
    // throughout the weekend. Both have identical returns on common dates.
    const stock = series("stock", [["2026-09-04", 100], ["2026-09-08", 110], ["2026-09-09", 99], ["2026-09-10", 118.8]]);
    const crypto = series("crypto", [["2026-09-04", 1000], ["2026-09-05", 2000], ["2026-09-06", 500], ["2026-09-07", 1500], ["2026-09-08", 1100], ["2026-09-09", 990], ["2026-09-10", 1188]]);
    const result = resolveStudies([stock, crypto], [study("corr", "correlation", ["stock", "crypto"], { period: 3 })]);
    const points = result.series[0]!.points;
    expect(points).toHaveLength(1);
    expect(points[0]!.date.toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(points[0]!.value).toBeCloseTo(1, 12);

    // A missing stock observation cannot be replaced by its previous close.
    stock.points.splice(1, 0, { date: new Date("2026-09-07"), observedAt: new Date("2026-09-07"), value: null });
    expect(resolveStudies([stock, crypto], [study("corr", "correlation", ["stock", "crypto"], { period: 3 })]).series[0]!.points).toEqual(points);
  });

  test("correlation waits for matching publication times instead of pairing equal observation dates", () => {
    const left = resolved("left");
    left.points = left.points.slice(0, 3);
    const right = { ...resolved("right", 2), points: left.points.map((point) => ({
      ...point, value: point.value! * 2,
      availableAt: new Date(point.date.getTime() + 12 * 60 * 60_000),
    })) };
    const calculation = study("corr", "correlation", ["left", "right"], { period: 2 });
    expect(resolveStudies([left, right], [calculation]).series[0]!.points).toHaveLength(0);
    left.points = left.points.map((point) => ({ ...point, availableAt: new Date(point.date.getTime() + 12 * 60 * 60_000) }));
    const [point] = resolveStudies([left, right], [calculation]).series[0]!.points;
    expect(point?.date).toEqual(new Date("2024-01-03T12:00:00Z"));
    expect(point?.availableAt).toEqual(point?.date);
    expect(point?.value).toBeCloseTo(1, 12);
  });

  test("volume studies preserve known instrument units and disclose unspecified provider volume", () => {
    for (const volumeUnit of ["shares", "contracts", undefined] as const) {
      const input = { ...resolved("volume-input"), volumeUnit };
      const result = resolveStudies([input], [study("volume", "volume", [input.id])]);
      expect(result.series[0]?.unit).toBe(volumeUnit ?? "");
      expect(result.series[0]?.points.map((point) => point.value)).toEqual(input.points.map((point) => point.volume));
      expect(result.warnings).toEqual(volumeUnit ? [] : ["Volume unit unknown: VOLUME-INPUT."]);
    }
  });

  test("returns actionable errors for missing inputs instead of throwing", () => {
    const result = resolveStudies([resolved("a")], [study("ratio", "ratio", ["a", "missing"])]);
    expect(result.series).toEqual([]);
    expect(result.errors[0]).toContain("requires 2 valid input series");
  });

  test("preserves the derived unit when a raw ratio mixes dimensions in one currency", () => {
    const price = { ...resolved("price"), unit: "USD/share", unitGroup: "price:USD" };
    const revenue = { ...resolved("revenue", 2), unit: "USD", unitGroup: "currency-total:USD" };
    const result = resolveStudies([price, revenue], [
      study("ratio", "ratio", ["price", "revenue"]),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.series[0]).toMatchObject({
      unit: "1/share",
      unitGroup: "derived-unit:1/share",
    });
    expect(result.series[0]?.points.every(({ value }) => value === 0.5)).toBe(true);
  });

  test("rejects a foreign-currency spread while preserving the ratio's derived units and warning", () => {
    const usd = { ...resolved("usd"), unit: "USD/share", unitGroup: "price:USD" };
    const jpy = { ...resolved("jpy"), unit: "JPY/share", unitGroup: "price:JPY" };
    const result = resolveStudies([usd, jpy], [
      study("ratio", "ratio", ["usd", "jpy"]),
      study("spread", "spread", ["usd", "jpy"]),
    ]);

    expect(result.warnings).toEqual([
      "ratio: ratio inputs use different currencies (USD and JPY); raw values are not FX-converted.",
    ]);
    expect(result.errors).toEqual([expect.stringContaining("spread: spread cannot subtract JPY (JPY/share) from USD (USD/share)")]);
    expect(result.series.find(({ id }) => id === "spread")).toBeUndefined();
    expect(result.series.find(({ id }) => id === "ratio")).toMatchObject({
      unit: "USD/JPY",
      unitGroup: "derived-unit:usd/jpy",
    });
  });

  test("describes incompatible spread dimensions without implying an FX problem", () => {
    const price = { ...resolved("price"), unit: "USD/share", unitGroup: "price:USD" };
    const revenue = { ...resolved("revenue", 2), unit: "USD", unitGroup: "currency-total:USD" };
    const result = resolveStudies([price, revenue], [
      study("spread", "spread", ["price", "revenue"]),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining("spread: spread cannot subtract REVENUE (USD) from PRICE (USD/share)")]);
    expect(result.series).toEqual([]);
  });

  test.each([
    ["unknown peer currency", "USD/share", "price:USD", "currency/share", "price", false],
    ["two unknown currencies", "currency/share", "price", "currency/share", "price", false],
    ["blank units", "", "unknown", "", "unknown", false],
    ["placeholder units", "unknown", "unknown", "unknown", "unknown", false],
    ["untyped scalar unit", "unit", "unknown", "unit", "unknown", false],
    ["unspecified price versus total", "USD", "price:USD", "USD", "currency-total:USD", false],
    ["two unspecified price bases", "USD", "price:USD", "USD", "price:USD", false],
    ["trailing price denominator", "USD/", "price:USD", "USD/", "price:USD", false],
    ["blank price denominator", "USD/   ", "price:USD", "USD/   ", "price:USD", false],
    ["empty compound price denominator", "USD//barrel", "price:USD", "USD//barrel", "price:USD", false],
    ["placeholder price denominator", "USD/?", "price:USD", "USD/?", "price:USD", false],
    ["explicit common physical basis", "USD/barrel", "price:USD", "USD/barrel", "price:USD", true],
    ["different physical bases", "USD/barrel", "price:USD", "USD/gallon", "price:USD", false],
    ["physical basis with conflicting currency metadata", "USD/barrel", "price:EUR", "USD/barrel", "price:EUR", false],
    ["same totals", "USD", "currency-total:USD", "USD", "currency-total:USD", true],
    ["price versus EPS", "USD/share", "price:USD", "USD/share", "per-share:USD", true],
    ["known crypto units", "USD/unit", "price:USD", "USD/unit", "price:USD", true],
    ["explicit common currency", "USD/share", "price:USD", "USD/share", "price:USD", true],
    ["pounds versus pence", "GBP/share", "price:GBP", "GBp/share", "price:GBp", false],
    ["equivalent pence symbols", "GBp/share", "price:GBp", "GBX/share", "price:GBX", true],
    ["same FX units", "USD/EUR", "derived-unit:usd/eur", "USD/EUR", "derived-unit:usd/eur", true],
    ["inverted FX units", "USD/EUR", "derived-unit:usd/eur", "EUR/USD", "derived-unit:eur/usd", false],
    ["rate percentages", "%", "percent", "%", "percent", true],
  ] as const)("checks spread units independently of ratio/correlation: %s", (_label, leftUnit, leftGroup, rightUnit, rightGroup, available) => {
    const inputs = [
      { ...resolved("left"), unit: leftUnit, unitGroup: leftGroup },
      { ...resolved("right", 2), unit: rightUnit, unitGroup: rightGroup },
    ];
    const others = [study("ratio", "ratio", ["left", "right"]), study("correlation", "correlation", ["left", "right"], { period: 3 })]
      .map((spec) => ({ ...spec, color: "#fff" }));
    const result = resolveStudies(inputs, [study("spread", "spread", ["left", "right"]), ...others]);
    expect(result.series.filter(({ id }) => id !== "spread")).toEqual(resolveStudies(inputs, others).series);
    expect(result.series.some(({ id }) => id === "spread")).toBe(available);
    expect(result.errors.length).toBe(available ? 0 : 1);
  });

  test("uses actual normalized input units and ignores their original currency provenance", () => {
    const usd = { ...resolved("usd"), unitGroup: "price:USD" };
    const eur = { ...resolved("eur", 2), unit: "EUR/share", unitGroup: "price:EUR" };
    for (const transform of ["percent", "index100"] as const) {
      const result = resolveStudies([usd, eur].map((input) => applyResolvedSeriesTransform(input, transform)), [study("spread", "spread", ["usd", "eur"])]);
      expect(result.errors).toEqual([]);
      expect(result.series[0]?.points.every(({ value }) => value === 0)).toBe(true);
    }
  });

  test("rejects incompatible spread metadata before empty or interrupted history can bypass it", () => {
    const left = resolved("left");
    const right = { ...resolved("right", 2), unit: "EUR/share", unitGroup: "price:EUR" };
    left.points[1] = { ...left.points[1]!, value: null, close: undefined, provenance: { priceHistoryIntegrity: {
      reason: "inconsistent-ohlc", sourcePoints: [{ date: left.points[1]!.date.toISOString(), open: 2, high: 1, low: 0, close: 2 }],
    } } };
    for (const inputs of [[left, right], [left, right].map((input) => ({ ...input, points: [] }))]) {
      const result = resolveStudies(inputs, [study("spread", "spread", ["left", "right"])]);
      expect(result.series).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("spread: spread cannot subtract");
    }
  });

  test("a multiplier cannot establish missing physical price units even across interrupted history", () => {
    const inputs = ["left", "right"].map((id) => ({ ...resolved(id), unit: "USD", unitGroup: "price:USD", priceAssetCategory: "FUTURE" }));
    inputs[0]!.points[1] = { ...inputs[0]!.points[1]!, value: null, close: undefined };
    for (const multiplier of [1, 42]) {
      const result = resolveStudies(inputs, [study("spread", "spread", ["left", "right"], { multiplier })]);
      expect(result.series).toEqual([]);
      expect(result.errors).toHaveLength(1);
    }
  });

  test.each([
    ["missing price basis", "USD", "price:USD", "USD", "price:USD", "unknown"],
    ["blank denominator", "USD/", "price:USD", "USD/", "price:USD", "unknown"],
    ["placeholder denominator", "USD/-", "price:USD", "USD/?", "price:USD", "unknown"],
    ["conflicting currency metadata", "USD/share", "price:EUR", "USD/share", "price:EUR", "unknown"],
    ["explicit same physical basis", "USD/barrel", "price:USD", "USD/barrel", "price:USD", "x"],
    ["explicit different physical bases", "USD/barrel", "price:USD", "USD/gallon", "price:USD", "gallon/barrel"],
    ["same currency totals", "USD", "currency-total:USD", "USD", "currency-total:USD", "x"],
    ["currency scales", "GBP/share", "price:GBP", "GBp/share", "price:GBp", "GBP/GBp"],
    ["pence aliases", "GBp/share", "price:GBp", "GBX/share", "price:GBX", "x"],
    ["currency and share aliases", "usd/shares", "price:USD", "USD/share", "price:USD", "x"],
  ] as const)("retains ratio values with verified unit factors: %s", (_label, leftUnit, leftGroup, rightUnit, rightGroup, expected) => {
    const inputs = [
      { ...resolved("left"), unit: leftUnit, unitGroup: leftGroup },
      { ...resolved("right", 2), unit: rightUnit, unitGroup: rightGroup },
    ];
    inputs[1]!.points[1] = { ...inputs[1]!.points[1]!, value: 0, close: 0 };
    const result = resolveStudies(inputs, [study("ratio", "ratio", ["left", "right"])]);
    expect(result.errors).toEqual([]);
    expect(result.series[0]?.unit).toBe(expected);
    expect(result.series[0]?.points[1]?.value).toBeNull();
    expect(result.series[0]?.points.filter((_, index) => index !== 1).every(({ value }) => value === 0.5)).toBe(true);
  });

  test("unknown ratio units remain unknown through nested ratios and cannot establish a spread", () => {
    const inputs = ["left", "right"].map((id) => ({ ...resolved(id), unit: "USD", unitGroup: "price:USD" }));
    const first = resolveStudies(inputs, [study("ratio", "ratio", ["left", "right"])]);
    const nested = resolveStudies(first.series, [study("nested", "ratio", ["ratio", "ratio"])]);
    const combined = [...first.series, ...nested.series];
    const spread = resolveStudies(combined, [study("spread", "spread", ["nested", "ratio"])]);
    expect(combined.map(({ id, unit, unitGroup }) => ({ id, unit, unitGroup }))).toEqual([
      { id: "ratio", unit: "unknown", unitGroup: "derived-unit:unknown" },
      { id: "nested", unit: "unknown", unitGroup: "derived-unit:unknown" },
    ]);
    expect(combined.every(({ points }) => points.every(({ value }) => value === 1))).toBe(true);
    expect(spread.errors).toEqual([expect.stringContaining("spread cannot subtract")]);
  });

  test("ratio axis groups distinguish opposite currency scales while retaining equivalent aliases", () => {
    const inputs = ["GBP", "GBp", "GBX"].map((currency) => ({ ...resolved(currency), unit: `${currency}/share`, unitGroup: `price:${currency}` }));
    const result = resolveStudies(inputs, [
      study("up", "ratio", ["GBP", "GBp"]),
      study("down", "ratio", ["GBp", "GBP"]),
      study("alias", "ratio", ["GBP", "GBX"]),
    ]);
    expect(result.series.map(({ unit }) => unit)).toEqual(["GBP/GBp", "GBp/GBP", "GBP/GBX"]);
    expect(result.series[0]!.unitGroup).not.toBe(result.series[1]!.unitGroup);
    expect(result.series[0]!.unitGroup).toBe(result.series[2]!.unitGroup);
    expect(result.series.every(({ points }) => points.every(({ value }) => value === 1))).toBe(true);
  });
});
