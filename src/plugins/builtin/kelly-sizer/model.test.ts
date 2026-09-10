import { describe, expect, test } from "bun:test";
import {
  buildBinaryOutcomes,
  buildKellyCurvePoints,
  buildSensitivityGrid,
  calculateKellySizing,
  solveKellyFraction,
  type BinaryKellyAssumptions,
  type PredictionMarketKellyAssumptions,
  type ScenarioKellyAssumptions,
} from "./model";

function expectClose(actual: number, expected: number, precision = 4) {
  expect(actual).toBeGreaterThan(expected - precision);
  expect(actual).toBeLessThan(expected + precision);
}

describe("kelly sizing model", () => {
  test("solves classic even-money Kelly sizing", () => {
    const result = solveKellyFraction(buildBinaryOutcomes(0.6, 1, -1));
    expectClose(result.fraction, 0.2);
    expectClose(result.expectedReturn, 0.2);
  });

  test("clips fractional binary Kelly by max name and max loss caps", () => {
    const draft: BinaryKellyAssumptions = {
      winProbability: 0.57,
      upsideReturn: 0.24,
      downsideReturn: -0.09,
      kellyFraction: 0.25,
      maxNameFraction: 0.08,
      maxLossFraction: 0.01,
    };

    const result = calculateKellySizing({
      mode: "binary",
      draft,
      bankroll: 100_000,
      currentValue: 4_000,
      price: 200,
    });

    expect(result.fullKellyFraction).toBeGreaterThan(4);
    expectClose(result.clippedFraction, 0.08);
    expect(result.clipReasons).toContain("max name");
    expectClose(result.targetValue, 8_000, 0.01);
    expectClose(result.addTrimValue, 4_000, 0.01);
    expectClose(result.estimatedUnits ?? 0, 20, 0.01);
    expectClose(result.riskFraction, 0.0072, 0.0001);

    const unavailable = calculateKellySizing({ mode: "binary", draft, bankroll: 100_000, currentValue: Number.NaN, price: 200 });
    expect(unavailable.recommendationLabel).toBe("Unavailable");
    expect(unavailable.addTrimValue).toBe(0);
    expect(unavailable.estimatedUnits).toBeNull();
    expect(unavailable.warnings).toContain("Current holding value unavailable; check FX rates.");
  });

  test("returns zero size when there is no positive edge", () => {
    const draft: BinaryKellyAssumptions = {
      winProbability: 0.45,
      upsideReturn: 0.1,
      downsideReturn: -0.1,
      kellyFraction: 0.25,
      maxNameFraction: 0.2,
      maxLossFraction: 0.05,
    };

    const result = calculateKellySizing({
      mode: "binary",
      draft,
      bankroll: 10_000,
    });

    expect(result.clippedFraction).toBe(0);
    expect(result.warnings).toContain("No positive Kelly edge.");
  });

  test("solves scenario trees numerically", () => {
    const draft: ScenarioKellyAssumptions = {
      outcomes: [
        { id: "loss", label: "Loss", probability: 0.4, returnPct: -1 },
        { id: "win", label: "Win", probability: 0.6, returnPct: 1 },
      ],
      kellyFraction: 1,
      maxNameFraction: 1,
      maxLossFraction: 1,
    };

    const result = calculateKellySizing({
      mode: "scenario",
      draft,
      bankroll: 1_000,
    });

    expectClose(result.fullKellyFraction, 0.2);
    expectClose(result.clippedFraction, 0.2);
  });

  test("uses risk budget size before Kelly when in risk budget mode", () => {
    const result = calculateKellySizing({
      mode: "risk-budget",
      draft: {
        riskBudgetFraction: 0.01,
        downsideReturn: -0.1,
        winProbability: 0.6,
        upsideReturn: 0.2,
        kellyFraction: 0.25,
        maxNameFraction: 1,
        maxLossFraction: 1,
      },
      bankroll: 50_000,
    });

    expectClose(result.unclippedFraction, 0.1);
    expectClose(result.clippedFraction, 0.1);
    expectClose(result.riskValue, 500);
  });

  test("sizes prediction market yes contracts from probability and price", () => {
    const draft: PredictionMarketKellyAssumptions = {
      estimatedProbability: 0.57,
      marketPrice: 0.48,
      side: "yes",
      kellyFraction: 1,
      maxNameFraction: 1,
      maxLossFraction: 1,
    };

    const result = calculateKellySizing({
      mode: "prediction-market",
      draft,
      bankroll: 1_000,
    });

    expectClose(result.fullKellyFraction, 0.173076, 0.0001);
    expectClose(result.clippedFraction, 0.173076, 0.0001);
  });

  test("builds sensitivity grid and Kelly curve data", () => {
    const draft: BinaryKellyAssumptions = {
      winProbability: 0.57,
      upsideReturn: 0.24,
      downsideReturn: -0.09,
      kellyFraction: 0.25,
      maxNameFraction: 0.08,
      maxLossFraction: 0.01,
    };

    const grid = buildSensitivityGrid("binary", draft);
    expect(grid.rows).toHaveLength(3);
    expect(grid.columns).toHaveLength(3);
    expect(grid.cells[1]?.[1]?.text).toBe("8.00%");

    const points = buildKellyCurvePoints("binary", draft);
    expect(points.length).toBeGreaterThan(10);
    expect(points[0]?.close).toBe(0);
  });
});
