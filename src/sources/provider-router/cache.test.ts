import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { cacheRouterResource, listCachedResources } from "./cache";
import { cleanupProviderRouterTestFiles, createTempDbPath, makeFinancials, makeQuote } from "./test-support";

afterEach(cleanupProviderRouterTestFiles);

test("refreshes legacy SEC annual caches without discarding unrelated data and accepts repaired writes", () => {
  const persistence = new AppPersistence(createTempDbPath("sec-annual-cache-version"));
  const key = { namespace: "market", kind: "financials", entityKey: "COST", variantKey: "exchange=NASDAQ", sourceKey: "provider:yahoo" };
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  const legacy = makeFinancials({ annualStatements: [{ date: "2017-09-03", netIncome: 919_000_000, fieldAvailability: { netIncome: "2017-10-18" } }] });
  persistence.resources.set(key, legacy, { cachePolicy });
  persistence.resources.set({ ...key, sourceKey: "provider:gloomberb-cloud" }, makeFinancials({ annualStatements: [{ date: "2025-08-31", netIncome: 8_099_000_000 }] }), { cachePolicy });
  persistence.resources.set({ ...key, kind: "quote" }, makeQuote({ symbol: "COST" }), { cachePolicy });
  const read = (kind: string) => listCachedResources(persistence.resources, kind, "COST", ["exchange=NASDAQ"], ["provider:yahoo", "provider:gloomberb-cloud"], true);
  expect(read("financials").map((row) => row.sourceKey)).toEqual(["provider:gloomberb-cloud"]);
  expect(read("quote")).toHaveLength(1);

  const repaired = makeFinancials({ annualStatements: [{ date: "2017-09-03", netIncome: 2_679_000_000, fieldAvailability: { netIncome: "2017-10-18" } }] });
  cacheRouterResource(persistence.resources, "financials", "COST", key.variantKey, key.sourceKey, repaired, cachePolicy);
  expect(read("financials").find((row) => row.sourceKey === "provider:yahoo")?.value).toEqual(repaired);
  persistence.close();
});

test("refreshes schema-two quarterly availability while retaining undated statements and unrelated cached data", () => {
  const persistence = new AppPersistence(createTempDbPath("field-availability-cache-version"));
  const key = { namespace: "market", kind: "financials", entityKey: "MSFT", variantKey: "exchange=NASDAQ", sourceKey: "provider:yahoo" };
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  const unsafe = makeFinancials({ annualStatements: [], quarterlyStatements: [{ date: "2025-12-31", totalRevenue: 100, grossProfit: 40,
    availableAt: "2026-04-01", fieldAvailability: { totalRevenue: "2026-04-01", grossProfit: "2026-02-01" } }] });
  persistence.resources.set(key, unsafe, { cachePolicy, schemaVersion: 2 });
  persistence.resources.set({ ...key, sourceKey: "provider:gloomberb-cloud" }, makeFinancials({ annualStatements: [], quarterlyStatements: [{ date: "2025-12-31", totalRevenue: 100 }] }), { cachePolicy, schemaVersion: 2 });
  persistence.resources.set({ ...key, kind: "quote" }, makeQuote({ symbol: "MSFT" }), { cachePolicy, schemaVersion: 2 });
  const read = (kind: string) => listCachedResources(persistence.resources, kind, "MSFT", [key.variantKey], [key.sourceKey, "provider:gloomberb-cloud"], true);
  expect(read("financials").map((row) => row.sourceKey)).toEqual(["provider:gloomberb-cloud"]);
  expect(read("quote")).toHaveLength(1);
  const repaired = makeFinancials({ annualStatements: [], quarterlyStatements: [{ date: "2025-12-31", totalRevenue: 100, grossProfit: 40,
    fieldAvailability: { grossProfit: "2026-02-01" } }] });
  cacheRouterResource(persistence.resources, "financials", "MSFT", key.variantKey, key.sourceKey, repaired, cachePolicy);
  expect(read("financials").find((record) => record.sourceKey === key.sourceKey)?.value).toEqual(repaired);
  persistence.close();
});
