import { describe, expect, test } from "bun:test";
import type { PaneSettingField } from "../../../types/plugin";
import {
  buildComparisonChartPreset,
  buildPriceChartPreset,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  setBuiltinStudies,
  setPairStudies,
} from "./presets";
import { CHART_SPEC_SETTING_KEY } from "./chart-spec";
import {
  applyChartComposerPaneSetting,
  buildChartComposerPaneSettingsDef,
  CHART_SETTING_KEYS,
  getChartInlineStyleTarget,
} from "./settings";

function field(key: string, type: PaneSettingField["type"] = "text"): PaneSettingField {
  if (type === "select") return { key, label: key, type, options: [] };
  if (type === "multi-select") return { key, label: key, type, options: [] };
  if (type === "ordered-multi-select") return { key, label: key, type, options: [] };
  if (type === "toggle") return { key, label: key, type };
  return { key, label: key, type };
}

describe("chart composer pane settings", () => {
  test("changed ordered pairs and removed/re-added formulas receive fresh defaults", () => {
    const original = setPairStudies(buildComparisonChartPreset(["TARGET", "ACQUIRER", "OTHER"]), ["spread", "correlation"]);
    original.studies = original.studies.map((study) => ({ ...study, parameters: study.kind === "spread" ? { multiplier: 0.5 } : { period: 13, returns: 0 } }));
    const apply = (spec: typeof original, selected: string[]) => applyChartComposerPaneSetting(
      { chartSpec: spec }, field(CHART_SETTING_KEYS.formulas, "multi-select"), selected,
    ).chartSpec as typeof original;
    const defaults = (spec: typeof original) => {
      expect(spec.studies.find(({ kind }) => kind === "spread")?.parameters).toEqual({ multiplier: 1 });
      expect(spec.studies.find(({ kind }) => kind === "correlation")?.parameters).toEqual({ period: 20, returns: 1 });
    };
    for (const series of [
      [original.series[1]!, original.series[0]!, original.series[2]!],
      [original.series[0]!, original.series[2]!, original.series[1]!],
    ]) {
      const updated = apply({ ...original, series }, ["spread", "correlation"]);
      defaults(updated);
      expect(updated.studies.map(({ inputSeriesIds }) => inputSeriesIds)).toEqual([
        series.slice(0, 2).map(({ id }) => id), series.slice(0, 2).map(({ id }) => id),
      ]);
    }
    const removed = apply(original, []);
    expect(removed.studies).toEqual([]);
    defaults(apply(removed, ["spread", "correlation"]));
    for (const edited of [
      { ...original, studies: original.studies.map((study) => ({ ...study, id: `pair:other-${study.kind}` })) },
      { ...original, studies: original.studies.map((study) => ({ ...study, kind: "ratio" as const })) },
    ]) defaults(apply(edited, ["spread", "correlation"]));
  });

  test("volatility settings persist independently through other indicators and source edits", () => {
    const original = setBuiltinStudies(buildPriceChartPreset("AAPL"), ["sma20", "realized-vol"]);
    const sma = original.studies.find((study) => study.kind === "sma")!;
    sma.parameters = { period: 17 };
    sma.color = "#abcdef";
    let settings: Record<string, unknown> = { chartSpec: original };
    const apply = (key: string, value: unknown) => {
      settings = applyChartComposerPaneSetting(settings, field(key), value);
    };
    apply(CHART_SETTING_KEYS.realizedVolWindow, "60");
    apply(CHART_SETTING_KEYS.realizedVolEstimator, "yang-zhang");
    apply(CHART_SETTING_KEYS.indicators, ["sma20", "realized-vol", "rsi14"]);
    apply(CHART_SETTING_KEYS.series, "AAPL:price, MSFT:price");
    const restored = JSON.parse(JSON.stringify(settings));
    const definition = buildChartComposerPaneSettingsDef(restored);
    expect(definition.values).toMatchObject({
      [CHART_SETTING_KEYS.realizedVolWindow]: "60",
      [CHART_SETTING_KEYS.realizedVolEstimator]: "yang-zhang",
    });
    const spec = restored.chartSpec as typeof original;
    expect(spec.studies.find((study) => study.kind === "realized-vol")!.parameters).toEqual({ window: 60, estimator: "yang-zhang" });
    expect(spec.studies.find((study) => study.kind === "sma")).toMatchObject({ parameters: { period: 17 }, color: "#abcdef" });
    expect(restored).not.toHaveProperty(CHART_SETTING_KEYS.realizedVolWindow);
    expect(restored).not.toHaveProperty(CHART_SETTING_KEYS.realizedVolEstimator);
    for (const value of ["", "1", "2.5", "NaN"]) expect(() => apply(CHART_SETTING_KEYS.realizedVolWindow, value)).toThrow();
    expect(() => apply(CHART_SETTING_KEYS.realizedVolEstimator, "unknown")).toThrow();
    apply(CHART_SETTING_KEYS.indicators, ["sma20"]);
    expect((settings.chartSpec as typeof original).panels.some((panel) => panel.id === "realized-vol")).toBe(false);
    apply(CHART_SETTING_KEYS.indicators, ["sma20", "realized-vol"]);
    expect((settings.chartSpec as typeof original).studies.find((study) => study.kind === "realized-vol")!.parameters)
      .toEqual({ window: 30, estimator: "close-to-close" });
  });

  test("routes multi-series styling through the series editor", () => {
    const spec = buildComparisonChartPreset(["AAPL", "MSFT"]);
    const definition = buildChartComposerPaneSettingsDef({
      [CHART_SPEC_SETTING_KEY]: spec,
    });

    expect(definition.fields.map((entry) => entry.key)).not.toContain(CHART_SETTING_KEYS.mode);
    expect(() => applyChartComposerPaneSetting(
      { [CHART_SPEC_SETTING_KEY]: spec },
      field(CHART_SETTING_KEYS.mode, "select"),
      "area",
    )).toThrow("Series editor");
    expect(getChartInlineStyleTarget({
      ...spec,
      series: [
        { ...spec.series[0]!, visible: false },
        spec.series[1]!,
      ],
    })).toBeNull();
  });

  test("updates nested chart state without persisting duplicate derived keys", () => {
    const original = buildPriceChartPreset("AAPL");
    const settings = {
      [CHART_SPEC_SETTING_KEY]: original,
      chartSeries: "stale",
      chartExpression: "stale",
    };
    const nextSettings = applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.series),
      "MSFT:revenue, AAPL:price",
    );
    const next = nextSettings[CHART_SPEC_SETTING_KEY] as typeof original;

    expect(next.series.map((entry) => (
      entry.source.kind === "security"
        ? [entry.source.instrument.symbol, entry.source.fieldId]
        : []
    ))).toEqual([
      ["MSFT", "fundamental.totalRevenue"],
      ["AAPL", "market.ohlcv"],
    ]);
    expect(next.series[1]?.id).toBe(original.series[0]?.id);
    expect(next.series[1]?.style).toBe("candles");
    expect(getSelectedBuiltinStudies(next)).toEqual(["volume"]);
    expect(nextSettings).not.toHaveProperty(CHART_SETTING_KEYS.series);
    expect(nextSettings).not.toHaveProperty("chartExpression");
  });

  test("applies range, resolution, custom dates, indicators, formulas, and single-series style", () => {
    let settings: Record<string, unknown> = {
      [CHART_SPEC_SETTING_KEY]: buildComparisonChartPreset(["AAPL", "MSFT"]),
    };
    settings = applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.indicators, "multi-select"),
      ["sma20"],
    );
    settings = applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.formulas, "multi-select"),
      ["ratio", "correlation"],
    );
    settings = applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.dateWindow),
      "2025-01-01 to 2025-06-30",
    );
    settings = applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.resolution, "select"),
      "1wk",
    );
    let spec = settings[CHART_SPEC_SETTING_KEY] as ReturnType<typeof buildComparisonChartPreset>;

    expect(getSelectedBuiltinStudies(spec)).toEqual(["sma20"]);
    expect(getSelectedPairStudies(spec)).toEqual(["ratio", "correlation"]);
    expect(spec.viewport.dateWindow).toEqual({ start: "2025-01-01", end: "2025-06-30" });
    expect(spec.viewport.resolution).toBe("1wk");
    settings = applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.range, "select"),
      "1Y",
    );
    spec = settings[CHART_SPEC_SETTING_KEY] as ReturnType<typeof buildComparisonChartPreset>;
    expect(spec.viewport.range).toBe("1Y");
    expect(spec.viewport.dateWindow).toBeUndefined();

    const single = applyChartComposerPaneSetting(
      { [CHART_SPEC_SETTING_KEY]: buildPriceChartPreset("AAPL") },
      field(CHART_SETTING_KEYS.mode, "select"),
      "area",
    )[CHART_SPEC_SETTING_KEY] as ReturnType<typeof buildPriceChartPreset>;
    expect(single.series[0]?.style).toBe("area");
  });

  test("rejects invalid date windows and incompatible modes", () => {
    const settings = { [CHART_SPEC_SETTING_KEY]: buildPriceChartPreset("AAPL") };
    expect(() => applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.dateWindow),
      "2025-02-30 to 2025-03-01",
    )).toThrow("valid date");
    expect(() => applyChartComposerPaneSetting(
      settings,
      field(CHART_SETTING_KEYS.mode, "select"),
      "columns",
    )).toThrow("not compatible");
  });
});
