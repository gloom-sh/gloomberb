import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import {
  createEarningsEstimatesHeadless,
  type EarningsEstimateSources,
} from "./headless";

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
  test("maps the shared event model into estimate rows", async () => {
    const definition = createEarningsEstimatesHeadless({
      loadSources: async () => sources,
    });

    const result = await definition.load(args({ kind: "all", limit: 50 }), context);

    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "Q Est",
        period: "next qtr",
        qEps: 1.2,
        qRevenue: 9_000_000_000,
        detail: "30E/28R",
      }),
      expect.objectContaining({
        status: "FY Est",
        annualEps: 4.8,
        annualRevenue: 35_000_000_000,
      }),
      expect.objectContaining({
        status: "Earnings",
        qEps: 0.48,
        value: "+6.67%",
      }),
    ]));
  });

  test("applies kind and limit options", async () => {
    const definition = createEarningsEstimatesHeadless({ loadSources: async () => sources });

    const result = await definition.load(args({ kind: "estimates", limit: 1 }), context);

    expect(result.rows).toHaveLength(1);
    expect(["Q Est", "FY Est"]).toContain(result.rows[0]?.status);
    expect(result.metadata).toMatchObject({ kind: "estimates", total: 2, truncated: true });
  });
});
