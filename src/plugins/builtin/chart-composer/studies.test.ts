import { describe, expect, test } from "bun:test";
import {
  builtinStudyPeriod,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  setBuiltinStudies,
  setBuiltinStudyPeriod,
  setPairStudies,
} from "./studies";
import { chartStudyLabel } from "./settings";
import { buildComparisonChartPreset, buildPriceChartPreset } from "./presets";

describe("chart composer studies", () => {
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

  test("an edited period survives toggling other indicators and names itself in the picker", () => {
    const withSma = setBuiltinStudies(buildPriceChartPreset("AAPL"), ["sma50"]);
    const edited = setBuiltinStudyPeriod(withSma, "sma50", 30);
    expect(builtinStudyPeriod(edited, "sma50")).toBe(30);
    // Turning another indicator on and off rebuilds the list from the selection.
    const toggled = setBuiltinStudies(setBuiltinStudies(edited, ["sma50", "rsi14"]), ["sma50"]);
    expect(builtinStudyPeriod(toggled, "sma50")).toBe(30);
    expect(chartStudyLabel("sma50", builtinStudyPeriod(toggled, "sma50"))).toBe("Simple moving average (SMA 30)");
    // An indicator that is not on keeps its default and is left alone.
    expect(setBuiltinStudyPeriod(toggled, "ema20", 9)).toBe(toggled);
    expect(builtinStudyPeriod(toggled, "ema20")).toBe(20);
  });
});
