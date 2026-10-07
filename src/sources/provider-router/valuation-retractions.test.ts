import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { BrokerAdapter } from "../../types/broker";
import { mapCloudFinancials } from "../gloomberb-cloud/normalizers";
import { buildOverviewStats } from "../../plugins/builtin/ticker-detail/overview/model";
import { cacheRouterResource } from "./cache";
import { mergeFinancials, mergeRefreshedFinancials, sanitizeCachedFinancials } from "./financials";
import { AssetDataRouter } from "./index";
import { attachTestRegistry, brokerInstance, setBrokerInstances } from "./test-support";
import { createTestFinancials, createTestQuote, fallbackProvider } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

afterEach(removeTempDbFiles);

const fields = ["enterpriseValue", "enterpriseToRevenue"] as const;
const recorded = createTestFinancials({
  quote: createTestQuote({ symbol: "ACME", listingExchangeName: "NASDAQ", currency: "USD", providerId: "gloomberb-cloud" }),
  fundamentals: { financialCurrency: "EUR", enterpriseValue: 43_716_311_028_848, enterpriseToRevenue: 1065.865,
    dividendYield: 0.0054, dividendYieldBasis: "forward", dividendYieldSource: "gloom", revenue: 32_667_300_000 },
  annualStatements: [{ date: "2025-12-31", currency: "EUR", totalRevenue: 32_667_300_000 }],
});
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("explicit cloud retraction survives serialization, cached fallback, and further sparse merges", () => {
  const corrected = mapCloudFinancials(roundTrip(createTestFinancials({
    quote: recorded.quote, fundamentals: { financialCurrency: "EUR", trailingPE: 58.7, unavailableFields: [...fields] },
  })));
  const merged = mergeFinancials(corrected, roundTrip(recorded))!;
  expect(merged.fundamentals).toEqual({ financialCurrency: "EUR", trailingPE: 58.7, unavailableFields: [...fields],
    dividendYield: 0.0054, dividendYieldBasis: "forward", dividendYieldSource: "gloom", revenue: 32_667_300_000 });
  expect(merged.annualStatements).toEqual(recorded.annualStatements);
  const sparse = createTestFinancials({ fundamentals: { financialCurrency: "EUR", forwardPE: 28.8 } });
  expect(mergeFinancials(sparse, roundTrip(merged))?.fundamentals?.unavailableFields).toEqual(fields);
  expect(mergeFinancials(merged, recorded)?.fundamentals?.enterpriseValue).toBeUndefined();
  // Omission is still a partial response, not a retraction.
  expect(mergeFinancials(sparse, recorded)?.fundamentals?.enterpriseValue).toBe(recorded.fundamentals!.enterpriseValue);
});

test("authoritative finite observations clear inherited markers without suppressing valid native values", () => {
  const unavailable = createTestFinancials({ fundamentals: { financialCurrency: "EUR", unavailableFields: [...fields] } });
  for (const value of [662_293_158_034, 0, -100]) {
    const native = createTestFinancials({ quote: { ...recorded.quote!, providerId: "gloom" },
      fundamentals: { financialCurrency: "EUR", enterpriseValue: value } });
    const merged = mergeFinancials(native, unavailable)!;
    expect(merged.fundamentals?.enterpriseValue).toBe(value);
    expect(merged.fundamentals?.unavailableFields).toEqual(["enterpriseToRevenue"]);
  }
  expect(mergeFinancials(createTestFinancials({ fundamentals: { enterpriseValue: Number.NaN } }), unavailable)?.fundamentals?.enterpriseValue).toBeUndefined();
  const repaired = createTestFinancials({ fundamentals: { enterpriseValue: 662_293_158_034, enterpriseToRevenue: 16 } });
  expect(mergeFinancials(repaired, unavailable)?.fundamentals?.unavailableFields).toBeUndefined();
});

test("standalone marked rows redact contradictory values and show the normal unavailable EV value", () => {
  const marked = roundTrip({ ...recorded, fundamentals: { ...recorded.fundamentals, unavailableFields: [...fields] } });
  for (const result of [mapCloudFinancials(marked), sanitizeCachedFinancials(marked, { includeStaleQuotes: true }), mergeFinancials(marked, null)!]) {
    expect(result.fundamentals?.enterpriseValue).toBeUndefined();
    expect(result.fundamentals?.enterpriseToRevenue).toBeUndefined();
    const stats = buildOverviewStats({ quote: result.quote, fundamentals: result.fundamentals,
      quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value });
    expect(stats.find((row) => row.label === "EV")?.value).toBe("—");
  }
});

test("malformed optional retraction metadata cannot throw or erase unrelated fields", () => {
  for (const unavailableFields of [42, ["revenue", "unknown"], null]) {
    const malformed = { ...recorded, fundamentals: { ...recorded.fundamentals, unavailableFields } } as unknown as typeof recorded;
    const value = mergeFinancials(mapCloudFinancials(malformed), recorded)!;
    expect(value.fundamentals?.unavailableFields).toBeUndefined();
    expect(value.fundamentals?.enterpriseValue).toBe(recorded.fundamentals!.enterpriseValue);
    expect(value.fundamentals?.revenue).toBe(32_667_300_000);
  }
});

test("enrichment preserves reporting currency for finite corrections but permits explicit retractions", () => {
  const fresh = createTestFinancials({ fundamentals: { financialCurrency: "USD", enterpriseValue: 662_293_158_034, enterpriseToRevenue: 16 } });
  expect(mergeRefreshedFinancials(recorded, fresh).fundamentals).toEqual(recorded.fundamentals);
  const unavailable = { ...fresh, fundamentals: { ...fresh.fundamentals, unavailableFields: [...fields] } };
  expect(mergeRefreshedFinancials(recorded, unavailable).fundamentals?.enterpriseValue).toBeUndefined();
  expect(mergeRefreshedFinancials(recorded, unavailable).fundamentals?.financialCurrency).toBe("EUR");
});

test("a newly fetched retraction overrides an earlier finite cache during profile or history enrichment", async () => {
  for (const profile of [undefined, { description: "Acme" }]) {
    const persistence = new AppPersistence(createTempDbPath("fresh-retraction-over-cache"));
    const cached = { ...recorded, profile };
    cacheRouterResource(persistence.resources, "financials", "ACME", "exchange=NASDAQ", "provider:gloomberb-cloud", cached,
      { staleMs: 60_000, expireMs: 120_000 });
    let loads = 0;
    const router = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud",
      async getTickerFinancials() {
        loads++;
        return createTestFinancials({ quote: recorded.quote, fundamentals: { unavailableFields: [...fields] } });
      },
    }, [], persistence.resources);
    const value = await router.getTickerFinancials("ACME", "NASDAQ");
    expect(loads).toBe(1);
    expect(value.fundamentals?.enterpriseValue).toBeUndefined();
    expect(value.fundamentals?.enterpriseToRevenue).toBeUndefined();
    expect(value.fundamentals?.dividendYield).toBe(0.0054);
    expect(value.annualStatements).toEqual(recorded.annualStatements);
    // The next authoritative finite correction must also replace the cached retraction.
    const repaired = new AssetDataRouter({ ...fallbackProvider, id: "gloomberb-cloud",
      async getTickerFinancials() {
        return createTestFinancials({ quote: recorded.quote, fundamentals: { enterpriseValue: 662_293_158_034, enterpriseToRevenue: 16 } });
      },
    }, [], persistence.resources);
    const recovered = await repaired.getTickerFinancials("ACME", "NASDAQ");
    expect(recovered.fundamentals?.enterpriseValue).toBe(662_293_158_034);
    expect(recovered.fundamentals?.enterpriseToRevenue).toBe(16);
    expect(recovered.fundamentals?.unavailableFields).toBeUndefined();
    persistence.close();
  }
});

test("provider enrichment preserves authoritative native and broker valuation contributions", async () => {
  for (const sourceKey of ["provider:gloom", "broker:ibkr:ibkr-work"]) {
    const persistence = new AppPersistence(createTempDbPath("valuation-contribution-priority"));
    const valid = { ...recorded, quote: { ...recorded.quote!, providerId: sourceKey.includes("broker") ? "ibkr" : "gloom", dataSource: "live" as const, price: 1700 },
      fundamentals: { financialCurrency: "EUR", enterpriseValue: 662_293_158_034 } };
    cacheRouterResource(persistence.resources, "financials", "ACME", "exchange=NASDAQ", sourceKey, valid,
      { staleMs: 60_000, expireMs: 120_000 });
    let cloudLoads = 0;
    const router = new AssetDataRouter(fallbackProvider, [{ ...fallbackProvider, id: "gloom", priority: 1,
      async getTickerFinancials() { throw new Error("Native provider temporarily unavailable"); },
    }, { ...fallbackProvider, id: "gloomberb-cloud", priority: 100,
      async getTickerFinancials() { cloudLoads++; return createTestFinancials({ quote: recorded.quote, fundamentals: { unavailableFields: [...fields] } }); },
    }], persistence.resources);
    const broker: BrokerAdapter = { id: "ibkr", name: "IBKR", configSchema: [], async validate() { return true; }, async importPositions() { return []; } };
    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);
    const result = await router.getTickerFinancials("ACME", "NASDAQ", sourceKey.includes("broker")
      ? { brokerId: "ibkr", brokerInstanceId: "ibkr-work" } : undefined);
    expect(cloudLoads).toBe(1);
    expect(result.fundamentals?.enterpriseValue).toBe(662_293_158_034);
    expect(result.fundamentals?.unavailableFields).not.toContain("enterpriseValue");
    if (sourceKey.includes("broker")) expect(result.quote?.price).toBe(1700);
    persistence.close();
  }
});

test("a quote-only primary cache cannot shield a fallback provider valuation from its own retraction", async () => {
  const persistence = new AppPersistence(createTempDbPath("mixed-valuation-origin"));
  const cachePolicy = { staleMs: 60_000, expireMs: 120_000 };
  cacheRouterResource(persistence.resources, "financials", "ACME", "exchange=NASDAQ", "provider:gloom",
    createTestFinancials({ quote: { ...recorded.quote!, providerId: "gloom" } }), cachePolicy);
  cacheRouterResource(persistence.resources, "financials", "ACME", "exchange=NASDAQ", "provider:gloomberb-cloud", recorded, cachePolicy);
  const router = new AssetDataRouter(fallbackProvider, [{ ...fallbackProvider, id: "gloom", priority: 1,
    async getTickerFinancials() { throw new Error("Native snapshot unavailable"); },
  }, { ...fallbackProvider, id: "gloomberb-cloud", priority: 100,
    async getTickerFinancials() { return createTestFinancials({ quote: recorded.quote, fundamentals: { unavailableFields: [...fields] } }); },
  }], persistence.resources);
  const result = await router.getTickerFinancials("ACME", "NASDAQ");
  expect(result.fundamentals?.enterpriseValue).toBeUndefined();
  expect(result.fundamentals?.enterpriseToRevenue).toBeUndefined();
  expect(result.fundamentals?.unavailableFields).toEqual(fields);
  expect(result.fundamentals?.revenue).toBe(32_667_300_000);
  persistence.close();
});
