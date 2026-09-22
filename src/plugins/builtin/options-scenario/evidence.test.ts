import { expect, test } from "bun:test";
import { readScenarioEvidence, scenarioSemanticEvidence } from "./evidence";
import { buildScenario, parseLegs } from "./model";

const scenario = buildScenario({ symbol: "AAPL", currency: "USD", spot: 100, rate: .04, dividendYield: .01,
  asOf: Date.UTC(2026, 8, 22, 14), legs: parseLegs("call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25") },
  { date: Date.UTC(2026, 9, 22, 14), volShift: .03, spotRange: .3 });

test("scenario evidence verifies both payoff curves and table values against position inputs", () => {
  for (const view of ["payoff", "grid", "legs"]) {
    const evidence = scenarioSemanticEvidence({ scenario, view, loading: false });
    expect(readScenarioEvidence(evidence)).toEqual(evidence);
  }
  const evidence = scenarioSemanticEvidence({ scenario, view: "payoff", loading: false });
  for (const key of ["selected", "expiry"] as const) {
    const corrupt = structuredClone(evidence);
    corrupt.scenario!.payoff[10]![key] += 1;
    expect(readScenarioEvidence(corrupt)).toBeNull();
  }
  const corruptGrid = structuredClone(evidence);
  corruptGrid.scenario!.grid[0]!.values[0]! += 1;
  expect(readScenarioEvidence(corruptGrid)).toBeNull();
  expect(readScenarioEvidence({ ...evidence, plottedValueCount: 9999 })).toBeNull();
  expect(readScenarioEvidence({ ...evidence, scenario: { ...scenario, controls: { ...scenario.controls, volShift: .1 } } })).toBeNull();
});

test("scenario evidence preserves failures and refuses empty or falsely complete captures", () => {
  const evidence = scenarioSemanticEvidence({ scenario, view: "grid", loading: false,
    error: "Quote refresh failed", notices: ["Using saved assumptions"] });
  expect(readScenarioEvidence(evidence)).toMatchObject({ complete: false, error: "Quote refresh failed", notices: ["Using saved assumptions"] });
  expect(readScenarioEvidence({ ...evidence, complete: true })).toBeNull();
  expect(readScenarioEvidence(scenarioSemanticEvidence({ scenario: null, view: "payoff", loading: false }))).toBeNull();
  expect(readScenarioEvidence({ ...evidence, scenario: { ...scenario, position: { ...scenario.position, legs: [] } } })).toBeNull();
});
