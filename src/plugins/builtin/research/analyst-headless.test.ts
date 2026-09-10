import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { AnalystResearchData } from "../../../types/financials";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createAnalystResearchHeadless } from "./analyst-headless";

const data: AnalystResearchData = {
  symbol: "AMD",
  currency: "USD",
  priceTarget: { current: 150, average: 180, low: 120, median: 175, high: 230 },
  recommendationRating: 8.4,
  recommendations: [{ period: "current month", strongBuy: 10, buy: 8, hold: 4, sell: 1 }],
  ratings: [
    { date: "2026-08-20", firm: "Beta", action: "Maintains", current: "Buy", currentPriceTarget: 190 },
    { date: "2026-08-25", firm: "Alpha", action: "Raises", current: "Buy", prior: "Hold", currentPriceTarget: 210, priorPriceTarget: 180 },
  ],
  earningsEstimates: [],
  revenueEstimates: [],
};

function context(): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-analyst"),
    signal: new AbortController().signal,
  };
}

function args(overrides: Partial<HeadlessPaneLoadArgs["options"]> = {}): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options: { sort: "date", order: "desc", limit: 25, ...overrides },
  };
}

describe("analyst research headless model", () => {
  test("keeps an explicit zero target distinct from missing data and exposes stale reference prices", async () => {
    const headless = createAnalystResearchHeadless({ loadData: async () => ({ ...data,
      stale: true, fetchedAt: "2026-09-09T16:00:00Z", priceTarget: { average: 0, current: 2, currency: "USD" },
    }) });
    const result = await headless.load(args(), context());
    expect(result.sections[0]?.entries?.slice(0, 3)).toMatchObject([
      { label: "Average target", value: 0 }, { label: "Target upside", value: -1 }, { label: "Upside reference price", value: 2 },
    ]);
    expect(result.errors).toEqual(["Analyst research is stale"]);
    expect(result.metadata).toMatchObject({ stale: true, fetchedAt: "2026-09-09T16:00:00Z" });
  });
  test("projects summary and ratings while applying sort and limit", async () => {
    const headless = createAnalystResearchHeadless({ loadData: async () => data });

    const latest = await headless.load(args({ limit: 1 }), context());
    expect(latest.sections[0]?.title).toBe("Summary");
    const entries = "entries" in latest.sections[0]! ? latest.sections[0]!.entries : [];
    expect(entries.slice(0, 2)).toMatchObject([
      { label: "Average target", value: 180 },
      { label: "Target upside", value: 0.2 },
    ]);
    expect(latest.sections[1]).toMatchObject({
      title: "Recent analyst actions",
      rows: [{ firm: "Alpha", currentPriceTarget: 210, priorPriceTarget: 180 }],
    });

    const byFirm = await headless.load(args({ sort: "firm", order: "desc", limit: 2 }), context());
    const ratings = "rows" in byFirm.sections[1]! ? byFirm.sections[1]!.rows : [];
    expect(ratings.map((row) => row.firm)).toEqual(["Beta", "Alpha"]);
  });
});
