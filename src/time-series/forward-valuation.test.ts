import { describe, expect, test } from "bun:test";
import type { EpsEstimateHistory, TickerFinancials } from "../types/financials";
import { extractFundamentalSeries } from "./fundamentals";
import type { SecuritySeriesSource } from "./types";

const source = (metric: string): SecuritySeriesSource => ({
  kind: "security",
  instrument: { symbol: "TEST", exchange: "NYSE" },
  fieldId: `valuation.${metric}`,
  period: "quarterly",
  timestampMode: "available-at",
});

/** Six reports one quarter apart; the last two are still unreported. */
const reported: EpsEstimateHistory["reported"] = [
  { date: "2025-01-30", epsEstimate: 1.0, epsActual: 1.1 },
  { date: "2025-04-30", epsEstimate: 1.1, epsActual: 1.2 },
  { date: "2025-07-30", epsEstimate: 1.2, epsActual: 1.3 },
  { date: "2025-10-30", epsEstimate: 1.3, epsActual: 1.4 },
  { date: "2026-01-29", epsEstimate: 1.4, epsActual: 1.5 },
  { date: "2026-04-30", epsEstimate: 1.5, epsActual: 1.6 },
];

const estimates = (overrides: Partial<EpsEstimateHistory> = {}): EpsEstimateHistory => ({
  currency: "USD",
  reported,
  consensus: [
    { period: "current year", date: "2026-12-31", average: 6.0 },
    { period: "next year", date: "2027-12-31", average: 8.0 },
  ],
  snapshots: [],
  ...overrides,
});

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Current-year weight is the fraction of the fiscal year still ahead of the observation. */
function blended(asOf: string, currentYear: number, nextYear: number, yearEnd = "2026-12-31"): number {
  const remaining = (Date.parse(yearEnd) - Date.parse(asOf)) / YEAR_MS;
  return currentYear * remaining + nextYear * (1 - remaining);
}

function financials(overrides: Partial<TickerFinancials> = {}): TickerFinancials {
  return {
    financialCurrency: "USD",
    quote: { symbol: "TEST", currency: "USD", price: 140, change: 0, changePercent: 0,
      lastUpdated: Date.parse("2026-09-30T20:00:00Z") },
    annualStatements: [],
    quarterlyStatements: [],
    // A flat price of 100 keeps every ratio equal to 100 over the EPS sum.
    priceHistory: ["2025-01-30", "2025-04-30", "2025-07-30", "2025-10-30", "2026-01-29", "2026-04-30", "2026-08-01", "2026-09-01"]
      .map((date) => ({ date: new Date(date), close: 100 })),
    epsEstimates: estimates(),
    ...overrides,
  };
}

describe("forward P/E history", () => {
  test("prices each report date over the next four pre-report consensus values, then today's blended consensus", () => {
    const points = extractFundamentalSeries(financials(), source("forwardPE"));
    expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value, point.provenance?.quality])).toEqual([
      // 100 / (1.1 + 1.2 + 1.3 + 1.4) and 100 / (1.2 + 1.3 + 1.4 + 1.5); later reports lack a full window.
      ["2025-01-30", 100 / 5.0, "derived"],
      ["2025-04-30", 100 / 5.4, "derived"],
      // About a quarter of 2026 is left at the quote, so the blend sits near 6 * 0.25 + 8 * 0.75.
      ["2026-09-30", 140 / blended("2026-09-30T20:00:00Z", 6, 8), "estimated"],
    ]);
    expect(points[0]!.periodLabel).toContain("2025-01-30");
    expect(points.at(-1)!.periodLabel).toBe("Current");
  });

  test("daily observations continue the series after the last full report window and never repeat earlier dates", () => {
    const data = financials({ epsEstimates: estimates({ snapshots: [
      // Same day as a report-date point: the report-date point stands.
      { observedOn: "2025-04-30", period: "current year", periodEnd: "2025-12-31", epsAverage: 4.0, source: "gloom" },
      { observedOn: "2025-04-30", period: "next year", periodEnd: "2026-12-31", epsAverage: 5.0, source: "gloom" },
      // Two thirds of 2026 ahead on 2026-05-01 with a Dec year end: 6 * 0.667 + 8 * 0.333.
      { observedOn: "2026-08-01", period: "current year", periodEnd: "2026-12-31", epsAverage: 6.0, source: "gloom-eps-trend" },
      { observedOn: "2026-08-01", period: "next year", periodEnd: "2027-12-31", epsAverage: 8.0, source: "gloom-eps-trend" },
      // Only a next-year value: used on its own.
      { observedOn: "2026-09-01", period: "next year", periodEnd: "2027-12-31", epsAverage: 8.0, source: "gloom" },
    ] }) });
    const points = extractFundamentalSeries(data, source("forwardPE"));
    expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
      ["2025-01-30", 100 / 5.0],
      ["2025-04-30", 100 / 5.4],
      ["2026-08-01", 100 / blended("2026-08-01", 6, 8)],
      ["2026-09-01", 100 / 8],
      ["2026-09-30", 140 / blended("2026-09-30T20:00:00Z", 6, 8)],
    ]);
    expect(points[2]!.periodLabel).toBe("Consensus observed 2026-08-01");
  });

  test("a currency the price cannot share, a missing estimate in the window and a loss all leave gaps", () => {
    const gbp = financials({ epsEstimates: estimates({ currency: "GBP" }) });
    expect(extractFundamentalSeries(gbp, source("forwardPE")).map((point) => point.value)).toEqual([]);

    const hole = financials({ epsEstimates: estimates({ reported: reported.map((row, index) => (
      index === 2 ? { date: row.date, epsActual: row.epsActual } : row
    )) }) });
    expect(extractFundamentalSeries(hole, source("forwardPE")).map((point) => point.date.toISOString().slice(0, 10)))
      .toEqual(["2026-09-30"]);

    // One deep loss quarter drags both NTM sums below zero; a negative consensus has no multiple either.
    const loss = financials({ epsEstimates: estimates({
      reported: reported.map((row, index) => (index === 3 ? { ...row, epsEstimate: -5 } : row)),
      consensus: [{ period: "next year", date: "2027-12-31", average: -1 }],
    }) });
    expect(extractFundamentalSeries(loss, source("forwardPE"))).toEqual([]);
    // A small loss quarter inside a positive NTM sum is still a multiple.
    const dip = financials({ epsEstimates: estimates({
      reported: reported.map((row, index) => (index === 3 ? { ...row, epsEstimate: -1 } : row)),
    }) });
    expect(extractFundamentalSeries(dip, source("forwardPE"))[0]!.value).toBeCloseTo(100 / (1.1 + 1.2 - 1 + 1.4));
  });

  test("without an estimate history the provider's own forward P/E remains the single point", () => {
    const data = financials({ epsEstimates: undefined, fundamentals: { forwardPE: 21 } });
    const points = extractFundamentalSeries(data, source("forwardPE"));
    expect(points.map((point) => [point.value, point.periodLabel, point.provenance?.quality])).toEqual([[21, "Current", "estimated"]]);
  });
});

test("realized NTM P/E divides the same report-date prices by the four quarters earned afterwards and stops before today", () => {
  const points = extractFundamentalSeries(financials(), source("realizedNtmPE"));
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
    ["2025-01-30", 100 / (1.2 + 1.3 + 1.4 + 1.5)],
    ["2025-04-30", 100 / (1.3 + 1.4 + 1.5 + 1.6)],
  ]);
  expect(points.some((point) => point.periodLabel === "Current")).toBe(false);
});
