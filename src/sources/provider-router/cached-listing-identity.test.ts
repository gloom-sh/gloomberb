import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { createTestDataProvider } from "../../test-support/data-provider";
import { useRegularMarketSession } from "../../test-support/market-session";
import type { TickerFinancials } from "../../types/financials";
import { cacheRouterResource, listCachedResources } from "./cache";
import { AssetDataRouter } from "./index";
import { cleanupProviderRouterTestFiles, createTempDbPath, makeFinancials, makeQuote } from "./test-support";

useRegularMarketSession();
afterEach(cleanupProviderRouterTestFiles);
const target = { symbol: "SHOP", exchange: "XNAS" };
const policy = { staleMs: 60_000, expireMs: 600_000 };
const value = (overrides: Partial<TickerFinancials> = {}) => makeFinancials({
  quote: makeQuote({ symbol: "SHOP", listingExchangeName: "NASDAQ", currency: "USD", providerId: "gloomberb-cloud" }),
  profile: { description: "Requested issuer" },
  annualStatements: [{ date: "2025-12-31", currency: "USD", totalRevenue: 100 }],
  ...overrides,
});

test("persisted public financials reject every conflicting identity before quote sanitation or merging", async () => {
  const matching = value();
  const cases: Array<Partial<TickerFinancials>> = [
    { quote: { ...matching.quote!, symbol: "OTHER", stale: true, lastUpdated: 1 } },
    { quote: { ...matching.quote!, listingExchangeName: "TSX", currency: "CAD" } },
    { quoteMetadata: { symbol: "OTHER", listingExchangeName: "NASDAQ" } },
    { quoteMetadata: { symbol: "SHOP", listingExchangeName: "TSX" } },
    { quote: undefined, quoteMetadata: { symbol: "OTHER", listingExchangeName: "NASDAQ" } },
    { quoteContributions: { yahoo: { ...matching.quote!, symbol: "OTHER" } } },
    { quoteContributions: { yahoo: { ...matching.quote!, listingExchangeName: "TSX" } } },
    { quoteMetadata: { symbol: 42, listingExchangeName: "NASDAQ" } as never },
    { quote: { ...matching.quote!, listingExchangeName: 42 } as never },
  ];
  for (const [index, invalid] of cases.entries()) {
    const path = createTempDbPath(`cached-listing-${index}`);
    let store = new AppPersistence(path);
    let requests = 0;
    const provider = createTestDataProvider({ id: "gloomberb-cloud", getTickerFinancials: async () => { requests++; return matching; } });
    const bad = value({ ...invalid, profile: { description: "Wrong cached issuer" },
      annualStatements: [{ date: "2025-12-31", currency: "USD", totalRevenue: 999 }] });
    try {
      // Include the legacy generic variant used as an exact-listing fallback.
      for (const variant of ["exchange=NASDAQ", ""]) cacheRouterResource(store.resources, "financials", "SHOP", variant,
        "provider:gloomberb-cloud", bad, policy);
      store.close(); store = new AppPersistence(path);
      const router = new AssetDataRouter(provider, [], store.resources);
      expect(router.getCachedFinancialsForTargets([target]).get("SHOP")).toBeUndefined();
      expect(listCachedResources(store.resources, "financials", "SHOP", ["exchange=NASDAQ", ""], ["provider:gloomberb-cloud"], true)).toEqual([]);
      const fresh = await router.getTickerFinancials("SHOP", "XNAS");
      expect(fresh.profile?.description).toBe("Requested issuer");
      expect(fresh.annualStatements[0]?.totalRevenue).toBe(100);
      expect(requests).toBe(1);
      store.close(); store = new AppPersistence(path);
      const reopened = new AssetDataRouter(provider, [], store.resources).getCachedFinancialsForTargets([target]).get("SHOP");
      expect(reopened?.annualStatements[0]?.totalRevenue).toBe(100);
      expect(reopened?.profile?.description).toBe("Requested issuer");
      expect(requests).toBe(1);
    } finally { store.close(); }
  }
});

test("cache selection falls through a conflicting source while preserving valid aliases and stale-quote research", () => {
  const store = new AppPersistence(":memory:");
  const good = value({ quote: { ...value().quote!, symbol: "SHOP:XNAS", listingExchangeName: "NMS", stale: true, lastUpdated: 1 } });
  const wrong = value({ quoteMetadata: { symbol: "OTHER", listingExchangeName: "NASDAQ" } });
  try {
    cacheRouterResource(store.resources, "financials", "SHOP", "exchange=NASDAQ", "provider:gloomberb-cloud", wrong, policy);
    cacheRouterResource(store.resources, "financials", "SHOP", "exchange=NASDAQ", "provider:yahoo", good, policy);
    const cloud = createTestDataProvider({ id: "gloomberb-cloud", priority: 1 });
    const yahoo = createTestDataProvider({ id: "yahoo", priority: 2 });
    const cached = new AssetDataRouter(yahoo, [cloud], store.resources).getCachedFinancialsForTargets([target]).get("SHOP")!;
    expect(cached.quote).toBeUndefined();
    expect(cached.quoteMetadata).toMatchObject({ symbol: "SHOP:XNAS", listingExchangeName: "NMS" });
    expect(cached.annualStatements).toEqual(good.annualStatements);
    expect(cached.profile).toEqual(good.profile);
    expect(listCachedResources(store.resources, "financials", "SHOP", ["exchange=NASDAQ"], ["provider:gloomberb-cloud", "provider:yahoo"], true)
      .map(record => record.sourceKey)).toEqual(["provider:yahoo"]);
  } finally { store.close(); }
});

test("a bare lookup that names no listing cannot answer for one venue's line", async () => {
  const store = new AppPersistence(":memory:");
  const boeing = makeQuote({ symbol: "BA", name: "Boeing Co/The", price: 201.81 });
  const bae = makeQuote({ symbol: "BA", name: "BAE Systems plc", listingExchangeName: "LSE", currency: "GBP", price: 20.23 });
  const requests: Array<string | undefined> = [];
  try {
    cacheRouterResource(store.resources, "quote", "BA", "", "provider:gloomberb-cloud", boeing, policy);
    const router = new AssetDataRouter(createTestDataProvider({ id: "gloomberb-cloud",
      getQuote: async (_symbol, exchange) => { requests.push(exchange); return bae; } }), [], store.resources);
    expect((await router.getQuote("BA", "LSE")).name).toBe("BAE Systems plc");
    expect((await router.getQuote("BA")).name).toBe("Boeing Co/The");
    expect(requests).toEqual(["LSE"]);
    // The bare entry still serves a venue it names.
    cacheRouterResource(store.resources, "quote", "SHOP", "", "provider:gloomberb-cloud",
      makeQuote({ symbol: "SHOP", listingExchangeName: "NASDAQ" }), policy);
    expect(listCachedResources(store.resources, "quote", "SHOP", ["exchange=NASDAQ", ""], ["provider:gloomberb-cloud"], true)).toHaveLength(1);
  } finally { store.close(); }
});

test("quote-only caches cannot inject another symbol into otherwise valid cached financials", () => {
  const store = new AppPersistence(":memory:");
  try {
    cacheRouterResource(store.resources, "financials", "SHOP", "exchange=NASDAQ", "provider:gloomberb-cloud", value({ quote: undefined }), policy);
    cacheRouterResource(store.resources, "quote", "SHOP", "exchange=NASDAQ", "provider:gloomberb-cloud",
      makeQuote({ symbol: "OTHER", listingExchangeName: "NASDAQ", price: 999 }), policy);
    const router = new AssetDataRouter(createTestDataProvider({ id: "gloomberb-cloud" }), [], store.resources);
    const cached = router.getCachedFinancialsForTargets([target]).get("SHOP")!;
    expect(cached.quote).toBeUndefined();
    expect(cached.annualStatements[0]?.totalRevenue).toBe(100);
    expect(listCachedResources(store.resources, "quote", "SHOP", ["exchange=NASDAQ"], ["provider:gloomberb-cloud"], true)).toEqual([]);
  } finally { store.close(); }
});

test("public cache identity checks retain exact suffix aliases, unidentified statement-only data and separate broker contracts", () => {
  const store = new AppPersistence(":memory:");
  const variants = ["exchange=NASDAQ"];
  const cases = [
    { entity: "SHOP", variant: variants[0]!, source: "provider:gloomberb-cloud", financials: value({ quote: undefined }) },
    { entity: "SHOP", variant: variants[0]!, source: "provider:yahoo", financials: value({ quote: undefined, quoteMetadata: { symbol: "SHOP" } }) },
    { entity: "SHOP", variant: variants[0]!, source: "provider:twelvedata", financials: value({ quote: makeQuote({ symbol: "SHOP" }) }) },
    { entity: "2330", variant: "exchange=TWSE", source: "provider:yahoo", financials: value({ quote: makeQuote({ symbol: "2330.TW", listingExchangeName: "TAI", currency: "TWD" }) }) },
    { entity: "contract:12345", variant: variants[0]!, source: "provider:gloomberb-cloud", financials: value() },
    { entity: "SHOP", variant: variants[0]!, source: "broker:account", financials: value({ quote: makeQuote({ symbol: "BROKER-LOCAL", listingExchangeName: "SMART" }) }) },
  ];
  try {
    for (const entry of cases) {
      cacheRouterResource(store.resources, "financials", entry.entity, entry.variant, entry.source, entry.financials, policy);
      expect(listCachedResources(store.resources, "financials", entry.entity, [entry.variant], [entry.source], true)[0]?.value).toEqual(entry.financials);
    }
  } finally { store.close(); }
});

test("legacy descriptive metadata stays symbol-less without bypassing its declared venue or other identities", () => {
  const store = new AppPersistence(":memory:");
  const descriptive = { currency: "USD", instrumentType: "Common Stock" } as TickerFinancials["quoteMetadata"];
  const cases: Array<{ metadata: TickerFinancials["quoteMetadata"]; quote: TickerFinancials["quote"]; accepted: boolean }> = [
    { metadata: descriptive, quote: value().quote, accepted: true },
    { metadata: descriptive, quote: undefined, accepted: true },
    { metadata: { ...descriptive!, listingExchangeName: "NMS" }, quote: undefined, accepted: true },
    { metadata: { ...descriptive!, listingExchangeName: "TSX" }, quote: value().quote, accepted: false },
    { metadata: { ...descriptive!, symbol: null } as never, quote: value().quote, accepted: false },
    { metadata: descriptive, quote: { ...value().quote!, symbol: "OTHER" }, accepted: false },
  ];
  try {
    for (const item of cases) {
      const input = value({ quote: item.quote, quoteMetadata: item.metadata });
      cacheRouterResource(store.resources, "financials", "SHOP", "exchange=NASDAQ", "provider:gloomberb-cloud", input, policy);
      const records = listCachedResources<TickerFinancials>(store.resources, "financials", "SHOP", ["exchange=NASDAQ"], ["provider:gloomberb-cloud"], true);
      expect(records.length).toBe(item.accepted ? 1 : 0);
      if (item.accepted) {
        expect(records[0]!.value).toEqual(input);
        expect(records[0]!.value.quoteMetadata?.symbol).toBeUndefined();
      }
    }
    cacheRouterResource(store.resources, "financials", "SHOP", "exchange=NASDAQ", "provider:gloomberb-cloud",
      value({ quoteMetadata: descriptive, quoteContributions: { public: { ...value().quote!, symbol: "OTHER" } } }), policy);
    expect(listCachedResources(store.resources, "financials", "SHOP", ["exchange=NASDAQ"], ["provider:gloomberb-cloud"], true)).toEqual([]);
  } finally { store.close(); }
});
