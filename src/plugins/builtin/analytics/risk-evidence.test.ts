import { expect, test } from "bun:test";
import {
  calculateAccountPerformance,
  calculateBrinson,
  parsePortfolioRiskEvidence,
  type PortfolioRiskEvidence,
} from "./risk-evidence";
const NOW = new Date("2026-09-22T12:00:00Z");
function fixture(): PortfolioRiskEvidence {
  return {
    version: 1,
    portfolioId: "main",
    currency: "USD",
    source: "Dated account statement",
    performance: {
      flowTiming: "end-of-day",
      externalFlowsComplete: true,
      observations: [
        { date: "2025-01-01", value: 100, externalFlow: 0 },
        { date: "2025-07-01", value: 160, externalFlow: 50 },
        { date: "2026-01-01", value: 180, externalFlow: 0 },
      ],
    },
    attribution: {
      method: "brinson-fachler",
      startDate: "2025-01-01",
      endDate: "2026-01-01",
      benchmark: "Declared sector benchmark",
      sectors: [
        {
          sector: "Technology",
          portfolioWeight: 0.6,
          benchmarkWeight: 0.4,
          portfolioReturn: 0.15,
          benchmarkReturn: 0.1,
        },
        {
          sector: "Industrials",
          portfolioWeight: 0.4,
          benchmarkWeight: 0.6,
          portfolioReturn: -0.05,
          benchmarkReturn: -0.02,
        },
      ],
    },
  };
}
const parsed = (value: unknown) =>
  parsePortfolioRiskEvidence(JSON.stringify(value), NOW)!;
test("TWR removes declared flows; MWR discounts actual dated investor cashflows", () => {
  const data = parsed(fixture());
  const result = calculateAccountPerformance(data.performance!);
  expect(result.twr).toBeCloseTo(0.2375, 12);
  expect(result.netFlows).toBe(50);
  expect(result.maxDrawdown).toBe(0);
  const annual = result.mwr!;
  const elapsed =
    (Date.parse("2025-07-01") - Date.parse("2025-01-01")) / (365 * 86_400_000);
  expect(-100 - 50 / (1 + annual) ** elapsed + 180 / (1 + annual)).toBeCloseTo(
    0,
    10,
  );
  expect(annual).not.toBeCloseTo(result.twr, 3);
});
test("deposits do not create return or drawdown; losses remain in the unitized path", () => {
  const data = fixture();
  data.performance!.observations[1] = {
    date: "2025-07-01",
    value: 180,
    externalFlow: 100,
  };
  data.performance!.observations[2] = {
    date: "2026-01-01",
    value: 180,
    externalFlow: 0,
  };
  const result = calculateAccountPerformance(parsed(data).performance!);
  expect(result.twr).toBeCloseTo(-0.2, 12);
  expect(result.maxDrawdown).toBeCloseTo(-0.2, 12);
});
test("MWR stays unavailable when flows can admit multiple roots", () => {
  const data = fixture();
  data.performance!.observations = [
    { date: "2023-01-01", value: 100, externalFlow: 0 },
    { date: "2024-01-01", value: 50, externalFlow: -200 },
    { date: "2025-01-01", value: 250, externalFlow: 200 },
    { date: "2026-01-01", value: 300, externalFlow: 0 },
  ];
  const result = calculateAccountPerformance(parsed(data).performance!);
  expect(result.mwr).toBeNull();
  expect(result.mwrReason).toContain("multiple IRRs");
  expect(Number.isFinite(result.twr)).toBe(true);
});
test("Brinson-Fachler effects reconcile to arithmetic active return", () => {
  const result = calculateBrinson(parsed(fixture()).attribution!);
  expect(result.portfolioReturn).toBeCloseTo(0.07, 12);
  expect(result.benchmarkReturn).toBeCloseTo(0.028, 12);
  expect(result.allocation).toBeCloseTo(0.024, 12);
  expect(result.selection).toBeCloseTo(0.002, 12);
  expect(result.interaction).toBeCloseTo(0.016, 12);
  expect(result.activeReturn).toBeCloseTo(0.042, 12);
  expect(result.reconciliationError).toBeCloseTo(0, 12);
});
test("evidence rejects missing flows, mixed periods, future dates and incomplete weights", () => {
  const missing = fixture();
  delete (missing.performance!.observations[1] as any).externalFlow;
  expect(() => parsed(missing)).toThrow("externalFlow");
  const duplicate = fixture();
  duplicate.performance!.observations[1]!.date = "2025-01-01";
  expect(() => parsed(duplicate)).toThrow("increasing dates");
  const future = fixture();
  future.attribution!.endDate = "2027-01-01";
  expect(() => parsed(future)).toThrow("dated");
  const weights = fixture();
  weights.attribution!.sectors[0]!.portfolioWeight = 0.5;
  expect(() => parsed(weights)).toThrow("sum to 1");
  const ambiguous = fixture();
  (ambiguous.performance as any).flowTiming = "unknown";
  expect(() => parsed(ambiguous)).toThrow("end-of-day");
  expect(() => parsed({ ...fixture(), token: "unexpected" })).toThrow(
    "unknown field",
  );
});
