import { describe, expect, test } from "bun:test";
import {
  canToggleChartSeries,
  parseChartSpec,
  projectVisibleChartSeries,
  serializeChartSpec,
  toggleChartSeries,
} from "./chart-spec";
import { applySeriesStyle, applySeriesTimestampMode } from "./chart-spec-edit";
import { setPairStudies } from "./studies";
import { buildComparisonChartPreset, buildCustomChartPreset, buildPriceChartPreset } from "./presets";

describe("chart composer series visibility", () => {
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

  test("migrates v1 security and economic specs but never treats v1 as capability-aware", () => {
    const legacy = buildCustomChartPreset("AAPL:price, FRED:CPIAUCSL");
    const migrated = parseChartSpec({ ...legacy, version: 1 });
    expect(migrated?.version).toBe(2);
    expect(migrated?.series.map((series) => series.source.kind)).toEqual(["security", "economic"]);

    const capability = buildCustomChartPreset("CAP:prediction-markets.series:polymarket/event-1/market-1");
    expect(parseChartSpec({ ...capability, version: 1 })).toBeNull();
    expect(parseChartSpec(serializeChartSpec(capability))).toEqual(parseChartSpec(capability));
  });

  test("rejects chart specs authored by a newer unsupported version", () => {
    const current = buildPriceChartPreset("AAPL");
    expect(parseChartSpec({ ...current, version: current.version + 1 })).toBeNull();
    expect(parseChartSpec({ ...current, version: String(current.version + 1) })).toBeNull();
  });
});
