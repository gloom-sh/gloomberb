import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { cacheRouterResource, listCachedResources } from "./cache";
import { cleanupProviderRouterTestFiles, createTempDbPath, makeFinancials, makeQuote } from "./test-support";

afterEach(cleanupProviderRouterTestFiles);

test("legacy cloud yields refresh without discarding quotes, accounts or native provider values", () => {
  const persistence = new AppPersistence(createTempDbPath("dividend-yield-provenance"));
  const key = { namespace: "market", kind: "financials", entityKey: "NESN", variantKey: "exchange=SWX", sourceKey: "provider:gloomberb-cloud" };
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  const old = makeFinancials({ quote: makeQuote({ symbol: "NESN", currency: "CHF" }),
    fundamentals: { dividendYield: 0.16, revenue: 88775000064 }, profile: { description: "Nestle" },
    annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }] });
  persistence.resources.set(key, old, { cachePolicy, schemaVersion: 4 });
  persistence.resources.set({ ...key, sourceKey: "provider:yahoo" }, old, { cachePolicy, schemaVersion: 4 });
  const read = (sourceKey = key.sourceKey) => listCachedResources(persistence.resources, "financials", "NESN", [key.variantKey], [sourceKey], true)[0]!;
  const record = read(); const value = record.value as ReturnType<typeof makeFinancials>;
  expect(record.stale).toBe(true);
  expect(value.fundamentals?.dividendYield).toBeUndefined();
  expect(value.quote).toEqual(old.quote);
  expect(value.annualStatements).toEqual(old.annualStatements);
  expect(value.fundamentals?.revenue).toBe(88775000064);
  expect((read("provider:yahoo").value as ReturnType<typeof makeFinancials>).fundamentals?.dividendYield).toBe(0.16);
  // A new client can cache an old backend response during a rolling deploy.
  cacheRouterResource(persistence.resources, "financials", "NESN", key.variantKey, key.sourceKey, old, cachePolicy);
  expect(read().schemaVersion).toBe(5);
  expect(read().stale).toBe(true);
  expect((read().value as ReturnType<typeof makeFinancials>).fundamentals?.dividendYield).toBeUndefined();
  expect((read().value as ReturnType<typeof makeFinancials>).quote).toEqual(old.quote);
  const corrected = { ...old, fundamentals: { ...old.fundamentals, dividendYield: 0.0399, dividendYieldBasis: "forward" as const, dividendYieldSource: "yahoo" as const } };
  cacheRouterResource(persistence.resources, "financials", "NESN", key.variantKey, key.sourceKey, corrected, cachePolicy);
  expect(read().schemaVersion).toBe(5);
  expect(read().stale).toBe(false);
  expect(read().value).toEqual(corrected);
  persistence.close();
});

test("legacy cloud financial caches retain statements but refresh quotes whose freshness was lost", () => {
  const persistence = new AppPersistence(createTempDbPath("nested-quote-freshness"));
  const key = { namespace: "market", kind: "financials", entityKey: "7203", variantKey: "exchange=TYO", sourceKey: "provider:gloomberb-cloud" };
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  const old = makeFinancials({ quote: makeQuote({ symbol: "7203", currency: "JPY", price: 2980.5, providerId: "gloomberb-cloud" }),
    annualStatements: [{ date: "2026-03-31", totalRevenue: 100, fieldAvailability: { totalRevenue: "2026-05-08" } }],
  });
  persistence.resources.set(key, old, { cachePolicy, schemaVersion: 3 });
  const quote = makeQuote({ symbol: "7203", currency: "JPY", price: 2994, providerId: "yahoo" });
  persistence.resources.set({ ...key, kind: "quote", sourceKey: "provider:yahoo" }, quote, { cachePolicy });
  const read = () => listCachedResources(persistence.resources, "financials", "7203", [key.variantKey], [key.sourceKey], true)[0]!.value as ReturnType<typeof makeFinancials>;
  expect(read().quote).toBeUndefined();
  expect(read().annualStatements).toEqual(old.annualStatements);
  expect(listCachedResources(persistence.resources, "quote", "7203", [key.variantKey], ["provider:yahoo"], true)[0]!.value).toEqual(quote);
  cacheRouterResource(persistence.resources, "financials", "7203", key.variantKey, key.sourceKey, { ...old, quote: { ...old.quote!, stale: true } }, cachePolicy);
  expect(read().quote?.stale).toBe(true);
  persistence.close();
});

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
