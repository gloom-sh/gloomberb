import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import {
  createEarningsEstimatesHeadless,
  type EarningsEstimateSources,
} from "./headless";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";

const sources: EarningsEstimateSources = {
  currency: "USD",
  actions: {
    symbol: "AMD",
    currency: "USD",
    dividends: [],
    splits: [],
    earnings: [{
      date: "2026-07-28",
      epsEstimate: 0.45,
      epsActual: 0.48,
      difference: 0.03,
      surprisePercent: 6.67,
    }],
  },
  estimates: {
    symbol: "AMD",
    currency: "USD",
    recommendations: [],
    ratings: [],
    earningsEstimates: [
      { date: "2026-09-30", period: "next_quarter", average: 1.2, analysts: 30 },
      { date: "2026-12-31", period: "current_year", average: 4.8, analysts: 32 },
    ],
    revenueEstimates: [
      { date: "2026-09-30", period: "next_quarter", average: 9_000_000_000, analysts: 28 },
      { date: "2026-12-31", period: "current_year", average: 35_000_000_000, analysts: 29 },
    ],
  },
  financials: {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
  },
};

function args(options: Record<string, string | number | boolean>): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options,
  };
}

const context = {} as HeadlessPaneContext;

describe("earnings estimates headless", () => {
  test("all excludes cash actions and reported excludes pending announcements and statement TTM", async () => {
    const definition = createEarningsEstimatesHeadless({ loadSources: async () => ({ ...sources, actions: { ...sources.actions!,
      dividends: [{ exDate: "2026-07-01", amount: 1 }],
      earnings: [...sources.actions!.earnings, { date: "2026-10-01", epsEstimate: 1 }],
    } }) });
    const all = await definition.load(args({ kind: "all" }), context);
    expect(all.rows.some((row) => row.status === "Dividend")).toBe(false);
    const reported = await definition.load(args({ kind: "reported" }), context);
    expect(reported.rows).toHaveLength(1);
    expect(reported.rows[0]).toMatchObject({ epsActual: 0.48, epsEstimate: 0.45, epsDifference: 0.03, surprisePercent: 6.67 });
  });

  test("stale source rows remain usable while reporting incomplete coverage", async () => {
    const definition = createEarningsEstimatesHeadless({ loadSources: async () => ({ ...sources, actions: { ...sources.actions!, stale: true } }) });
    const result = await definition.load(args({ kind: "all" }), context);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.errors?.join(" ")).toContain("stale");
  });

  test("applies kind and limit options", async () => {
    const definition = createEarningsEstimatesHeadless({ loadSources: async () => sources });

    const result = await definition.load(args({ kind: "estimates", limit: 1 }), context);

    expect(result.rows).toHaveLength(1);
    expect(["Q Est", "FY Est"]).toContain(String(result.rows[0]?.status));
    expect(result.metadata).toMatchObject({ kind: "estimates", total: 2, truncated: true });
    expect(result.rows[0]?.epsBasis).toBe("unknown");
  });
});

test("EE reads a surprise against a loss estimate and growth off a year-ago loss N/M, as EVTS does, and exports no figure for either", async () => {
  const definition = createEarningsEstimatesHeadless({ loadSources: async () => ({
    ...sources,
    actions: { ...sources.actions!, earnings: [{ date: "2026-07-28", epsEstimate: -1.47, epsActual: -1.14, difference: 0.33, surprisePercent: -22.45 }] },
    estimates: { ...sources.estimates!, revenueEstimates: [],
      earningsEstimates: [{ date: "2026-09-30", period: "next_quarter", average: 0.1, yearAgo: -0.4, growth: 1.25, analysts: 30 }] },
  }) });
  const request = args({ kind: "all" });
  const result = await definition.load(request, context);
  expect(result.rows.find((row) => row.status === "Earnings")).toMatchObject({ surpriseNotMeaningful: true, surprisePercent: undefined });
  expect(result.rows.find((row) => row.status === "Q Est")).toMatchObject({ estimateGrowthNotMeaningful: true, estimateGrowthMetric: "eps" });
  const text = renderHeadlessPaneText(definition, result, request, "EE");
  expect(text).toMatch(/\bN\/M\b/);
  expect(text).toContain("N/M EPS");
  expect(text).not.toContain("-22.45");
  expect(text).not.toContain("+125");
  const csv = renderReportCsv(headlessReportTables(definition, result, request, "EE", deriveHeadlessFreshness(definition, result), { complete: true, unavailableSymbols: [] }));
  const [header, ...lines] = csv.split("\n");
  const columns = header!.split(",");
  const surprise = columns.findIndex((column) => column.startsWith("EPS surp"));
  const growth = columns.findIndex((column) => column.startsWith("YoY growth"));
  const status = columns.indexOf("status");
  expect([surprise, growth, status].every((index) => index > -1)).toBe(true);
  const earnings = lines.find((line) => line.includes(",Earnings,"))!.split(",");
  expect(earnings[surprise]).toBe("");
  expect(earnings[status]).toContain("EPS surp: n/m");
  const estimate = lines.find((line) => line.includes(",Q Est,"))!.split(",");
  expect(estimate[growth]).toBe("");
  expect(estimate[status]).toContain("YoY growth: n/m");
});
