import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { cacheRouterResource, FINANCIALS_SCHEMA_VERSION, listCachedResources, QUOTE_SCHEMA_VERSION } from "./cache";
import { createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

afterEach(removeTempDbFiles);

test("financials and quotes written under another schema version are misses until rewritten", () => {
  const persistence = new AppPersistence(createTempDbPath("market-schema-gate"));
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  const key = { namespace: "market", entityKey: "MSFT", variantKey: "exchange=NASDAQ", sourceKey: "provider:yahoo" };
  const financials = createTestFinancials({ annualStatements: [{ date: "2025-06-30", totalRevenue: 100 }] });
  const quote = createTestQuote({ symbol: "MSFT" });
  const read = (kind: string) => listCachedResources(persistence.resources, kind, "MSFT", [key.variantKey], [key.sourceKey], true);
  for (const [kind, value, current] of [["financials", financials, FINANCIALS_SCHEMA_VERSION], ["quote", quote, QUOTE_SCHEMA_VERSION]] as const) {
    for (const schemaVersion of [current - 1, current + 1]) {
      persistence.resources.set({ ...key, kind }, value, { cachePolicy, schemaVersion });
      expect(read(kind)).toEqual([]);
    }
    cacheRouterResource(persistence.resources, kind, "MSFT", key.variantKey, key.sourceKey, value, cachePolicy);
    expect(read(kind)[0]?.schemaVersion).toBe(current);
    expect(read(kind)[0]?.value).toEqual(value);
  }
  persistence.close();
});

test("cloud yields without provenance refresh without discarding quotes, accounts or native provider values", () => {
  const persistence = new AppPersistence(createTempDbPath("dividend-yield-provenance"));
  const key = { namespace: "market", kind: "financials", entityKey: "NESN", variantKey: "exchange=SWX", sourceKey: "provider:gloomberb-cloud" };
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  const old = createTestFinancials({ quote: createTestQuote({ symbol: "NESN", currency: "CHF" }),
    fundamentals: { dividendYield: 0.16, revenue: 88775000064 }, profile: { description: "Nestle" },
    annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }] });
  // A new client can cache an old backend response during a rolling deploy.
  for (const sourceKey of [key.sourceKey, "provider:yahoo"]) cacheRouterResource(persistence.resources, "financials", "NESN", key.variantKey, sourceKey, old, cachePolicy);
  const read = (sourceKey = key.sourceKey) => listCachedResources(persistence.resources, "financials", "NESN", [key.variantKey], [sourceKey], true)[0]!;
  const record = read(); const value = record.value as ReturnType<typeof createTestFinancials>;
  expect(record.stale).toBe(true);
  expect(value.fundamentals?.dividendYield).toBeUndefined();
  expect(value.quote).toEqual(old.quote);
  expect(value.annualStatements).toEqual(old.annualStatements);
  expect(value.fundamentals?.revenue).toBe(88775000064);
  expect((read("provider:yahoo").value as ReturnType<typeof createTestFinancials>).fundamentals?.dividendYield).toBe(0.16);
  const corrected = { ...old, fundamentals: { ...old.fundamentals, dividendYield: 0.0399, dividendYieldBasis: "forward" as const, dividendYieldSource: "yahoo" as const } };
  cacheRouterResource(persistence.resources, "financials", "NESN", key.variantKey, key.sourceKey, corrected, cachePolicy);
  expect(read().stale).toBe(false);
  expect(read().value).toEqual(corrected);
  persistence.close();
});
