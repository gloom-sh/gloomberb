import { expect, spyOn, test } from "bun:test";
import type { FundMembersPayload } from "../../../api-client/members";
import { comparePortfolioSectors } from "./risk-sectors";

const benchmark = { members: [
  { sector: "Information Technology", weight: .6 }, { sector: "Financials", weight: .4 },
] } as FundMembersPayload;

test("sector active weights use net liquidation with cash and shorts, combine aliases and retain unknown weights", () => {
  const result = comparePortfolioSectors([
    { symbol: "TECH", marketValue: 120 }, { symbol: "BANK", marketValue: -20 },
    { symbol: "FUND", marketValue: 10 }, { symbol: "CASH", marketValue: -10 }, { symbol: "MISSING", marketValue: null },
  ], 100, benchmark, new Map([["TECH", "Technology"], ["BANK", "Financial Services"]]));
  expect(result.rows.find(row => row.sector === "Information Technology")).toMatchObject({ portfolioWeightPercent: 120, benchmarkWeightPercent: 60, activeWeightPp: 60 });
  expect(result.rows.find(row => row.sector === "Financials")).toMatchObject({ portfolioWeightPercent: -20, activeWeightPp: -60 });
  expect(result.rows.find(row => row.sector === "Cash")).toMatchObject({ portfolioWeightPercent: -10 });
  expect(result.unknown).toHaveLength(2);
  expect(result.rows.reduce((sum, row) => sum + row.portfolioWeightPercent, 0)).toBe(100);
  expect(() => comparePortfolioSectors([], 0, benchmark, new Map())).toThrow("positive net liquidation");
  expect(() => comparePortfolioSectors([], 100, { members: [] } as never, new Map())).toThrow("benchmark");
});

test("the sector view labels the returned benchmark and its holdings date, without loading risk histories", async () => {
  const { createTestHeadlessContext, createTestHeadlessArgs } = await import("../../../test-support/headless");
  const { createTestDataProvider, createTestQuote } = await import("../../../test-support/data-provider");
  const { createTestTicker } = await import("../../../test-support/ticker");
  const { portfolioRiskHeadless } = await import("./risk-headless");
  const portfolio = { id: "book", name: "Book", currency: "USD" };
  const ticker = createTestTicker("ACME", "Acme", { exchange: "NASDAQ", portfolios: ["book"],
    positions: [{ portfolio: "book", shares: 10, avgCost: 80, currency: "USD", broker: "manual" }] });
  const context = createTestHeadlessContext({
    config: { ...createTestHeadlessContext().config, portfolios: [portfolio], watchlists: [] },
    resolvePortfolio: async () => ({ portfolio, tickers: [ticker] }),
    marketData: createTestDataProvider({
      getQuote: async () => createTestQuote({ symbol: "ACME", price: 100 }),
      getTickerFinancialsBatch: async targets => targets.map(target => ({ target, financials: { annualStatements: [], quarterlyStatements: [], priceHistory: [], profile: { sector: "Technology" } } })),
      getPriceHistory: async () => { throw new Error("Sector weights do not need price histories"); },
    }),
    apiClient: { getFundMembers: async () => ({ ...benchmark, fund: { ticker: "IVV" }, asOf: "2026-11-05", snapshotAsOf: "2026-11-07T12:00:00Z", stale: false }) } as never,
  });
  const result = await portfolioRiskHeadless.load(createTestHeadlessArgs({ rawArgument: "book", argument: "book", options: { view: "sectors" } }), context);
  expect(result.complete).toBe(true);
  expect(result.metadata).toMatchObject({ benchmark: "IVV", benchmarkAsOf: "2026-11-05" });
  expect(result.sections[0]?.rows?.find(row => row.sector === "Information Technology")).toMatchObject({ portfolioWeightPercent: 100, activeWeightPp: 40 });
});

test("equal symbols on different venues retain separate sectors even when the batch returns in reverse order", async () => {
  const { createTestHeadlessContext, createTestHeadlessArgs } = await import("../../../test-support/headless");
  const { createTestDataProvider } = await import("../../../test-support/data-provider");
  const { collectionHoldingsHeadless } = await import("../portfolio-list/headless");
  const { portfolioRiskHeadless } = await import("./risk-headless");
  const holdings = spyOn(collectionHoldingsHeadless, "load").mockResolvedValue({
    rows: [{ symbol: "SAN", exchange: "NYSE", marketValue: 50 }, { symbol: "SAN", exchange: "EPA", marketValue: 50 }],
    complete: true, metadata: { positions: 2, totals: { total: 100 } },
  });
  try {
    const context = createTestHeadlessContext({
      marketData: createTestDataProvider({ getTickerFinancialsBatch: async targets => targets.map(target => ({ target,
        financials: { annualStatements: [], quarterlyStatements: [], priceHistory: [], profile: { sector: target.exchange === "NYSE" ? "Financial Services" : "Healthcare" } },
      })).reverse() }),
      apiClient: { getFundMembers: async () => ({ fund: { ticker: "IVV" }, asOf: "2026-11-05", stale: false,
        members: [{ sector: "Financials", weight: .5 }, { sector: "Health Care", weight: .5 }] }) } as never,
    });
    const result = await portfolioRiskHeadless.load(createTestHeadlessArgs({ options: { view: "sectors" } }), context);
    expect(result.complete).toBe(true);
    expect(result.sections[0]?.rows).toEqual([
      { sector: "Financials", portfolioWeightPercent: 50, benchmarkWeightPercent: 50, activeWeightPp: 0 },
      { sector: "Health Care", portfolioWeightPercent: 50, benchmarkWeightPercent: 50, activeWeightPp: 0 },
    ]);
  } finally { holdings.mockRestore(); }
});
