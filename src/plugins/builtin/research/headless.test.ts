import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import {
  createEarningsEstimatesHeadless,
  type EarningsEstimateSources,
} from "./headless";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import { EXPORT_IDENTITY_COLUMNS, exportIdentityCells } from "../../../cli/export-source";

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
    expect(reported.rows[0]).toMatchObject({ epsActual: 0.48, epsEstimate: 0.45, epsBasis: "unknown", epsDifference: undefined, surprisePercent: undefined });
    expect(reported.errors ?? []).toEqual([]);
    expect(reported.metadata?.unmatchedReportedPeriods).toEqual(["2026-07-28"]);
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

  test("--view prints one of the pane's views under Next up, while --kind keeps picking the rows", async () => {
    const definition = createEarningsEstimatesHeadless({ loadSources: async () => sources });
    const text = async (options: Record<string, string>) => {
      const request = args({ kind: "all", ...options });
      const result = await definition.load(request, context);
      return { result, text: renderHeadlessPaneText(definition, result, request, "EE") };
    };
    const reported = await text({ view: "reported" });
    expect(reported.text).toMatch(/Date\s+Quarter\s+EPS\s+Est\s+Surprise/);
    expect(reported.text).toContain("Next up");
    expect(reported.text).not.toContain("EPS low");
    expect(reported.text).not.toContain("Reported quarters");
    expect(reported.result.metadata).toMatchObject({ kind: "all", view: "reported" });
    // The exports keep every row --kind asks for.
    expect(reported.result.rows.map((row) => row.status)).toEqual(expect.arrayContaining(["Earnings", "Q Est", "FY Est"]));
    const estimates = await text({ view: "estimates" });
    expect(estimates.text).toMatch(/Period\s+Ends\s+EPS\s+EPS low/);
    expect(estimates.text).not.toContain("Reported quarters");
  });
});

test("EE reads a surprise against a loss estimate and growth off a year-ago loss N/M, as EVTS does, and exports no figure for either", async () => {
  const definition = createEarningsEstimatesHeadless({ loadSources: async () => ({
    ...sources,
    actions: { ...sources.actions!, earnings: [
      { date: "2026-07-28", epsEstimate: -1.47, epsActual: -1.14, surprisePercent: -22.45, epsBasis: "gaap", epsActualSource: "press-release" },
      { date: "2026-04-28", epsEstimate: -1.47, epsActual: -1.14, difference: 0.33, surprisePercent: -22.45 },
    ] },
    estimates: { ...sources.estimates!, revenueEstimates: [],
      earningsEstimates: [{ date: "2026-09-30", period: "next_quarter", average: 0.1, yearAgo: -0.4, growth: 1.25, analysts: 30 }] },
  }) });
  const request = args({ kind: "all" });
  const result = await definition.load(request, context);
  const quarter = (date: string) => result.rows.find((row) => row.status === "Earnings" && row.date === date);
  expect(quarter("2026-07-28")).toMatchObject({ epsBasis: "GAAP", surpriseNotMeaningful: true, surprisePercent: undefined });
  expect(quarter("2026-04-28")).toMatchObject({ epsActual: -1.14, epsEstimate: -1.47, epsBasis: "unknown", epsDifference: undefined, surprisePercent: undefined });
  expect(quarter("2026-04-28")).not.toHaveProperty("surpriseNotMeaningful");
  expect(result.rows.find((row) => row.status === "Q Est")).toMatchObject({ estimateGrowthNotMeaningful: true, estimateGrowthMetric: "eps" });
  const text = renderHeadlessPaneText(definition, result, request, "EE");
  // The estimate's growth in its row and in Next up, the reported quarter's surprise in its own table.
  expect(text).toMatch(/next qtr\s+30 Sep 2026\s+0\.10\s+\S\s+\S\s+N\/M\s+30/);
  expect(text).toMatch(/EPS est\s+0\.10\s+30 analysts · N\/M y\/y/);
  expect(text).toMatch(/Jul 2026\s+-1\.14\s+-1\.47\s+N\/M/);
  expect(text).toMatch(/Apr 2026\s+-1\.14\s+-1\.47\s+—/);
  expect(text).not.toContain("-22.45");
  expect(text).not.toContain("+125");
  const csv = renderReportCsv(headlessReportTables(definition, result, request, "EE", deriveHeadlessFreshness(definition, result), { complete: true, unavailableSymbols: [] }));
  const [header, ...lines] = csv.split("\n");
  const columns = header!.split(",");
  const surprise = columns.findIndex((column) => column.startsWith("EPS surp"));
  const growth = columns.findIndex((column) => column.startsWith("YoY growth"));
  const status = columns.indexOf("status");
  expect([surprise, growth, status].every((index) => index > -1)).toBe(true);
  const earnings = lines.find((line) => line.includes("2026-07-28,Earnings,"))!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  expect(earnings[surprise]).toBe("");
  expect(earnings[status]).toContain("EPS surp: n/m");
  const unverified = lines.find((line) => line.includes("2026-04-28,Earnings,"))!.split(",");
  expect(unverified[surprise]).toBe("");
  expect(unverified[status]).not.toContain("EPS surp: n/m");
  const estimate = lines.find((line) => line.includes(",Q Est,"))!.split(",");
  expect(estimate[growth]).toBe("");
  expect(estimate[status]).toContain("YoY growth: n/m");
});

test("EE names Visa's quarters and years as GUIDE does, says which quarter has no consensus, and dates its export", async () => {
  // Visa's fiscal year ends in September: its December 2026 quarter is Q1 FY2027, as its guidance names it.
  const definition = createEarningsEstimatesHeadless({ loadSources: async () => ({
    currency: "USD",
    actions: { symbol: "V", currency: "USD", dividends: [], splits: [], fetchedAt: "2026-11-16T23:50:30.815Z",
      earnings: [
        { date: "2027-01-26", fiscalPeriod: "2026-12", epsEstimate: 3.63, epsAnalysts: 26 },
        { date: "2026-10-27", fiscalPeriod: "2026-09", epsEstimate: 3.43, epsActual: 3.48, difference: 0.05, epsBasis: "adjusted" },
        // A quarter Gloom Cloud has an actual for and no consensus.
        { date: "2026-07-28", fiscalPeriod: "2026-06", epsActual: 3.32, epsBasis: "gaap" },
      ] },
    estimates: { symbol: "V", currency: "USD", recommendations: [], ratings: [], fetchedAt: "2026-11-16T22:42:15.571Z",
      earningsEstimates: [
        { date: "2026-12-31", period: "current_quarter", average: 3.63, analysts: 26 },
        { date: "2027-09-30", period: "current_year", average: 15.03, analysts: 38 },
      ],
      revenueEstimates: [] },
    financials: { annualStatements: [{ date: "2026-09-30" }, { date: "2025-09-30" }], quarterlyStatements: [], priceHistory: [] },
  }) });
  const request = args({ kind: "all" });
  const result = await definition.load(request, context);
  const period = (status: string, date: string) => result.rows.find((row) => row.status === status && row.date === date);
  expect(period("Earnings", "2027-01-26")?.period).toBe("Q1 FY2027");
  expect(period("Earnings", "2026-10-27")?.period).toBe("Q4 FY2026");
  expect(period("Q Est", "2026-12-31")).toMatchObject({ period: "Q1 FY2027", detail: "cur qtr, 26 EPS analysts" });
  expect(period("FY Est", "2027-09-30")).toMatchObject({ period: "FY2027", detail: "cur yr, 38 EPS analysts" });
  expect(period("Earnings", "2026-07-28")?.detail).toBe("GAAP, no consensus");
  // Dated by Gloom Cloud's newer read: the export's as_of, never blank.
  const asOf = exportIdentityCells(deriveHeadlessFreshness(definition, result, Date.parse("2026-11-17T00:15:00Z")))[EXPORT_IDENTITY_COLUMNS.indexOf("as_of")];
  expect(asOf).toBe("2026-11-16T23:50:30.815Z");
  // Without a year on record a quarter keeps the month it ends in.
  const bare = createEarningsEstimatesHeadless({ loadSources: async () => ({ ...sources }) });
  expect((await bare.load(request, context)).rows.find((row) => row.status === "Earnings")?.period).toBe("—");
});

test("EE says a report out with no actual yet is pending, as ERN and the board do", async () => {
  const definition = createEarningsEstimatesHeadless({ loadSources: async () => ({
    ...sources,
    // Out yesterday: the calendar's figure is due within the week it reads the date for.
    actions: { ...sources.actions!, earnings: [{ date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), fiscalPeriod: "2026-10", time: "After Hours", epsEstimate: 2.49, epsAnalysts: 14, dateStatus: "reported" }] },
  }) });
  const result = await definition.load(args({ kind: "all" }), context);
  // In the place a date's status takes before it is out, with the time of day after it.
  expect(result.rows.find((row) => row.status === "Earnings")?.detail).toBe("pending, After Hours, 14 analysts");
});
