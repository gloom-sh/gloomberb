import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPersistence } from "../../data/app-persistence";
import { apiClient } from "../../api-client";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { quoteMetadataFromQuote } from "../../market-data/quotes/metadata";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { Quote, TickerFinancials } from "../../types/financials";
import { AssetDataRouter } from "./index";
import { FINANCIALS_SCHEMA_VERSION } from "./cache";
import { mergeFinancials, mergeRefreshedFinancials, sanitizeCachedFinancials } from "./financials";

let clock: ReturnType<typeof spyOn>;
beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T18:00:00Z")); });
afterEach(() => clock.mockRestore());
const issuerFields = { marketCap: 200, trailingPE: 12, revenue: 0, netIncome: 0, operatingCashFlow: 0, freeCashFlow: 0 };
function snapshot(quote?: Quote): TickerFinancials {
  return { quote, fundamentals: issuerFields, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
}
function quote(instrumentType?: string, listingExchangeName?: string): Quote {
  return { symbol: "FUND", currency: "USD", instrumentType, listingExchangeName, price: 105,
    change: 0, changePercent: 0, lastUpdated: Date.now(), marketState: "REGULAR" };
}

for (const venue of ["ARCA", undefined]) for (const state of ["fresh", "stale", "metadata-only"] as const) {
  test(`${state} fund classification with ${venue ?? "unknown venue"} prevents cached issuer enrichment`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "gloom-fund-metadata-"));
    const db = join(dir, "cache.sqlite");
    let store = new AppPersistence(db);
    const q = { ...quote("ETF", venue), stale: state !== "fresh" };
    const fresh: TickerFinancials = { ...snapshot(q),
      fundamentals: { dividendYield: 0.03, dividendYieldBasis: "trailing", dividendYieldSource: "twelvedata" },
      profile: { description: "Verified fund" },
    };
    let loads = 0;
    const transport = spyOn(apiClient, "getCloudFinancials").mockImplementation(async () => {
      loads++; return { status: "success", data: fresh };
    });
    const price = spyOn(apiClient, "getCloudQuote").mockRejectedValue(new Error("No independent current quote"));
    const provider = state === "metadata-only" ? createTestDataProvider({
      getTickerFinancials: async () => { loads++; return { ...fresh, quote: undefined, quoteMetadata: quoteMetadataFromQuote(q) }; },
      getQuote: async () => { throw new Error("No independent current quote"); },
    }) : new GloomberbCloudProvider();
    try {
      store.resources.set({ namespace: "market", kind: "financials", entityKey: "FUND", variantKey: "", sourceKey: `provider:${provider.id}` },
        snapshot({ ...quote(), stale: true }), { schemaVersion: FINANCIALS_SCHEMA_VERSION, cachePolicy: { staleMs: 60_000, expireMs: 300_000 } });
      store.close(); store = new AppPersistence(db);
      const result = await new AssetDataRouter(provider, [], store.resources).getTickerFinancials("FUND");
      expect(loads).toBe(1);
      store.close(); store = new AppPersistence(db);
      const reopened = new AssetDataRouter(provider, [], store.resources).getCachedFinancialsForTargets([{ symbol: "FUND" }]).get("FUND");
      for (const value of [result, reopened]) {
        expect(value?.quoteMetadata?.instrumentType).toBe("ETF");
        expect(value?.fundamentals).toMatchObject({ dividendYield: 0.03, dividendYieldBasis: "trailing", dividendYieldSource: "twelvedata" });
        for (const field of Object.keys(issuerFields) as Array<keyof typeof issuerFields>) expect(value?.fundamentals?.[field]).toBeUndefined();
        expect(value?.annualStatements).toEqual([]);
        if (!venue) expect(value?.quoteMetadata?.listingExchangeName).toBeUndefined();
        if (state !== "fresh") {
          expect(value?.quote).toBeUndefined();
          expect(value?.quoteMetadata?.source?.stale).toBe(true);
          expect(value?.quoteMetadata?.source?.lastUpdated).toBe(q.lastUpdated);
        }
      }
    } finally { transport.mockRestore(); price.mockRestore(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("price freshness cannot change the research type or lend a fund an untyped yield", () => {
  const legacy = { ...snapshot(), profile: { description: "Unverified issuer" }, fundamentals: { ...issuerFields, dividendYield: 0.9 },
    annualStatements: [{ date: "2025-12-31", totalRevenue: 200 }] };
  const metadataOnly = (type?: string): TickerFinancials => ({ ...snapshot(), fundamentals: undefined,
    quoteMetadata: quoteMetadataFromQuote({ ...quote(type), stale: true }) });
  for (const type of ["ETF", "INDEX", "CURRENCY", "FUTURE", "CRYPTOCURRENCY"]) {
    const merged = mergeFinancials(legacy, metadataOnly(type))!;
    expect(merged.fundamentals).toBeUndefined();
    expect(merged.profile).toBeUndefined();
    expect(merged.annualStatements).toEqual([]);
  }
  for (const type of ["EQUITY", undefined]) {
    const merged = mergeFinancials(legacy, metadataOnly(type))!;
    expect(merged.fundamentals?.revenue).toBe(0);
    expect(merged.annualStatements[0]?.totalRevenue).toBe(200);
  }
  // A later untyped valuation overlay cannot undo the known instrument policy.
  const freshValuation = { ...snapshot(), fundamentals: { enterpriseValue: 100 } };
  expect(mergeRefreshedFinancials(metadataOnly("ETF"), freshValuation).fundamentals).toBeUndefined();
  expect(mergeRefreshedFinancials(metadataOnly("EQUITY"), freshValuation).fundamentals?.enterpriseValue).toBe(100);
  const company = { ...legacy, quote: quote("EQUITY"), quoteMetadata: metadataOnly("ETF").quoteMetadata };
  expect(sanitizeCachedFinancials(company).annualStatements[0]?.totalRevenue).toBe(200);
  const staleCompany = { ...company, quote: { ...company.quote, stale: true } };
  expect(sanitizeCachedFinancials(staleCompany).quote).toBeUndefined();
  expect(sanitizeCachedFinancials(staleCompany).quoteMetadata?.instrumentType).toBe("EQUITY");
  expect(sanitizeCachedFinancials(staleCompany).annualStatements[0]?.totalRevenue).toBe(200);
});
