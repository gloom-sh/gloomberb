import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { AnalystResearchData } from "../../../types/financials";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createAnalystResearchHeadless } from "./analyst-headless";
import { createTestHeadlessContext } from "../../../test-support/headless";

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
    const result = await headless.load(args(), createTestHeadlessContext());
    expect(result.sections[0]?.entries?.slice(0, 3)).toMatchObject([
      { label: "Average target", value: 0 }, { label: "Target upside", value: -1 }, { label: "Upside reference price", value: 2 },
    ]);
    expect(result.errors).toEqual(["Analyst research is stale"]);
    expect(result.metadata).toMatchObject({ stale: true, fetchedAt: "2026-09-09T16:00:00Z" });
  });
  test("projects summary and ratings while applying sort and limit", async () => {
    const headless = createAnalystResearchHeadless({ loadData: async () => data });

    const latest = await headless.load(args({ limit: 1 }), createTestHeadlessContext());
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

    const byFirm = await headless.load(args({ sort: "firm", order: "desc", limit: 2 }), createTestHeadlessContext());
    const ratings = "rows" in byFirm.sections[1]! ? byFirm.sections[1]!.rows : [];
    expect(ratings.map((row) => row.firm)).toEqual(["Beta", "Alpha"]);
  });
});

test("default analyst loader keeps remembered venue and returns unknown currency/counts without defaults", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const headless = createAnalystResearchHeadless();
  const ctx = createTestHeadlessContext();
  ctx.resolveInstrument = async (symbol) => ({ symbol, exchange: "LSE" });
  ctx.marketData = createTestDataProvider({ getAnalystResearch: async (symbol, exchange) => {
    calls.push([symbol, exchange]);
    return { ...data, symbol, currency: undefined, priceTarget: { average: 0, current: 2 }, recommendations: [] };
  } });
  const result = await headless.load(args(), ctx);
  expect(calls).toEqual([["AMD", "LSE"]]);
  expect(result.metadata?.currency).toBeNull();
  expect(result.sections[0]?.entries?.[0]).toMatchObject({ value: 0, formatted: "0.00 (ccy?)" });
  expect(result.sections[0]?.entries?.find((entry) => entry.label === "Analysts")?.value).toBeNull();
  expect(result.sections[1]?.rows?.[0]?.currency).toBeNull();
});
