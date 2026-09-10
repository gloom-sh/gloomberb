import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { MarketDataRequestContext } from "../../types/data-provider";
import { AssetDataRouter } from "./index";
import { cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider, makeFinancials, makeQuote } from "./test-support";

const rows = Array.from({ length: 19 }, (_, index) => ({ date: `${2007 + index}-12-31`, currency: "USD", totalRevenue: 100 + index, operatingIncome: 40, inventory: 5 }));
const financials = (extended: boolean, status: "available" | "retryable-failure" = "available") => makeFinancials({
 quote: makeQuote(), profile: { description: "Microsoft Corporation" }, annualStatements: extended ? rows : rows.slice(-5),
 ...(extended ? { statementHistory: { mode: "extended" as const, source: "sec" as const, status, fetchedAt: new Date().toISOString() } } : {}),
});
afterEach(cleanupProviderRouterTestFiles);

test("extended requests bypass a default deep cache and reuse the whole extended source for later counts", async () => {
 const persistence = new AppPersistence(createTempDbPath("extended"));
 const calls: Array<MarketDataRequestContext | undefined> = [];
 const provider = { ...fallbackProvider, async getTickerFinancials(_symbol: string, _exchange?: string, context?: MarketDataRequestContext) { calls.push(context); return financials(context?.statementHistory === "extended"); } };
 const router = new AssetDataRouter(provider, [], persistence.resources);
 try {
  expect((await router.getTickerFinancials("MSFT", "NASDAQ")).annualStatements).toHaveLength(5);
  expect((await router.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended" })).annualStatements).toHaveLength(19);
  const second = new AssetDataRouter(provider, [], persistence.resources);
  expect((await second.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended" })).annualStatements).toHaveLength(19);
  expect((await second.getTickerFinancials("MSFT", "NASDAQ")).annualStatements).toHaveLength(5);
  expect(calls.map(c => c?.statementHistory)).toEqual([undefined, "extended"]);
 } finally { persistence.close(); }
});

test("failed extension keeps usable rows and retries instead of caching a shallow answer for statement TTL", async () => {
 const persistence = new AppPersistence(createTempDbPath("extended-retry"));
 let calls = 0;
 const provider = { ...fallbackProvider, async getTickerFinancials() { calls++; return financials(true, calls === 1 ? "retryable-failure" : "available"); } };
 const router = new AssetDataRouter(provider, [], persistence.resources);
 try {
  expect((await router.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended" })).annualStatements).toHaveLength(19);
  expect((await router.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended" })).statementHistory?.status).toBe("available");
  expect(calls).toBe(2);
 } finally { persistence.close(); }
});

test("mixed batches retain extended intent through the single route instead of default batch cache", async () => {
 let batches = 0;
 const contexts: Array<MarketDataRequestContext | undefined> = [];
 const router = new AssetDataRouter({ ...fallbackProvider,
  async getTickerFinancialsBatch(targets) { batches++; return targets.map(target => ({ target, financials: financials(false) })); },
  async getTickerFinancials(_symbol, _exchange, context) { contexts.push(context); return financials(context?.statementHistory === "extended"); },
 });
 const result = await router.getTickerFinancialsBatch([{ symbol: "MSFT", exchange: "NASDAQ", statementHistory: "extended" }, { symbol: "V", exchange: "NYSE" }]);
 expect(result.map(item => item.financials?.annualStatements.length)).toEqual([19, 5]);
 expect(contexts[0]?.statementHistory).toBe("extended");
 expect(batches).toBe(1);
});

test("a failed refresh preserves the previous extended rows across repeated retries", async () => {
 const persistence = new AppPersistence(createTempDbPath("extended-last-good"));
 let failed = false;
 const provider = { ...fallbackProvider, async getTickerFinancials() {
  const value = financials(true, failed ? "retryable-failure" : "available");
  return failed ? { ...value, annualStatements: value.annualStatements.slice(-4) } : value;
 } };
 const router = new AssetDataRouter(provider, [], persistence.resources);
 try {
  await router.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended" });
  failed = true;
  for (let attempt = 0; attempt < 2; attempt++) {
   const value = await router.getTickerFinancials("MSFT", "NASDAQ", { statementHistory: "extended", cacheMode: "refresh" });
   expect(value.annualStatements).toHaveLength(19);
   expect(value.statementHistory?.status).toBe("retryable-failure");
  }
 } finally { persistence.close(); }
});
