import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { quoteMetadataFromQuote } from "../../market-data/quotes/metadata";
import { useRegularMarketSession } from "../../test-support/market-session";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import { cacheRouterResource } from "./cache";
import { AssetDataRouter } from "./index";
import { createTestFinancials, createTestQuote, fallbackProvider } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

useRegularMarketSession();
afterEach(removeTempDbFiles);

const profile = { description: "JPMorgan Chase & Co.", sector: "Financial Services", industry: "Banks - Diversified" };
const cachePolicy = { staleMs: 60_000, expireMs: 300_000 };
const instrument = { brokerId: "ibkr", conId: 1520593, symbol: "JPM", primaryExchange: "NYSE" };

function company(overrides: Partial<TickerFinancials> = {}): TickerFinancials {
  return createTestFinancials({
    quote: createTestQuote({ symbol: "JPM", listingExchangeName: "NYSE", instrumentType: "EQUITY", providerId: "gloomberb-cloud", price: 310 }),
    financialCurrency: "USD",
    annualStatements: Array.from({ length: 5 }, (_, i) => ({ date: `${2021 + i}-12-31`, currency: "USD", totalRevenue: 100 + i, inventory: 1 })),
    statementHistory: { mode: "extended", source: "sec", status: "available", fetchedAt: new Date(Date.now()).toISOString() },
    ...overrides,
  });
}

function secondary(overrides: Partial<TickerFinancials> = {}): TickerFinancials {
  return createTestFinancials({ profile,
    quoteMetadata: quoteMetadataFromQuote(createTestQuote({ symbol: "JPM", listingExchangeName: "NYQ", instrumentType: "EQUITY", providerId: "gloom" })),
    ...overrides,
  });
}

function providers(cloudValue = company(), gloomValue = secondary()) {
  const calls = { cloud: 0, gloom: 0, batch: 0 };
  const contexts: Array<MarketDataRequestContext | undefined> = [];
  const cloud: DataProvider = { ...fallbackProvider, id: "gloomberb-cloud", priority: 100,
    async getTickerFinancials(_symbol, _exchange, context) { calls.cloud++; contexts.push(context); return cloudValue; },
    async getTickerFinancialsBatch(targets) { calls.batch++; return targets.map(target => ({ target, financials: cloudValue })); },
  };
  const gloom: DataProvider = { ...fallbackProvider, id: "gloom",
    async getTickerFinancials(_symbol, _exchange, context) { calls.gloom++; contexts.push(context); return gloomValue; },
  };
  return { cloud, gloom, calls, contexts };
}

for (const warm of [false, true]) test(`${warm ? "cached" : "fresh"} extended statements recover an exact-listing profile in its own source cache`, async () => {
  const dbPath = createTempDbPath(`profile-${warm}`);
  let persistence = new AppPersistence(dbPath);
  const value = company();
  const { cloud, gloom, calls, contexts } = providers(value);
  const variant = "exchange=NYSE;history=extended:v1";
  try {
    if (warm) cacheRouterResource(persistence.resources, "financials", "JPM", variant, "provider:gloomberb-cloud", value, cachePolicy);
    const result = await new AssetDataRouter(gloom, [cloud], persistence.resources).getTickerFinancials("JPM", "NYSE", { statementHistory: "extended" });
    expect(result.profile).toEqual(profile);
    expect(result.quote?.price).toBe(310);
    expect(result.annualStatements).toEqual(value.annualStatements);
    expect(calls).toEqual({ cloud: 1, gloom: 1, batch: 0 });
    expect(contexts.map(context => context?.statementHistory)).toEqual(["extended", "extended"]);

    persistence.close();
    persistence = new AppPersistence(dbPath);
    const read = (sourceKey: string) => persistence.resources.get<TickerFinancials>({ namespace: "market", kind: "financials", entityKey: "JPM", variantKey: variant, sourceKey })!.value;
    expect(read("provider:gloomberb-cloud").profile).toBeUndefined();
    expect(read("provider:gloom").profile).toEqual(profile);
    expect(read("provider:gloom").quoteMetadata).toMatchObject({ symbol: "JPM", listingExchangeName: "NYQ", source: { providerId: "gloom" } });
    expect(read("provider:gloom").quote).toBeUndefined();
    const reopened = await new AssetDataRouter(gloom, [cloud], persistence.resources).getTickerFinancials("JPM", "NYSE", { statementHistory: "extended" });
    expect(reopened.profile).toEqual(profile);
    expect(reopened.quote?.price).toBe(310);
    expect(calls).toEqual({ cloud: 1, gloom: 1, batch: 0 });
  } finally { persistence.close(); }
});

for (const contract of [false, true]) for (const mismatch of ["exchange", "symbol", "missing-identity"] as const) {
  test(`${mismatch} cannot classify a ${contract ? "contract" : "public"} listing on fetch or cache reopen`, async () => {
    const persistence = new AppPersistence(createTempDbPath(`profile-reject-${contract}-${mismatch}`));
    const quoteMetadata = mismatch === "missing-identity" ? undefined : quoteMetadataFromQuote(createTestQuote({
      symbol: mismatch === "symbol" ? "BAC" : "JPM", listingExchangeName: mismatch === "exchange" ? "LSE" : "NYSE",
    }));
    const { cloud, gloom, calls } = providers(company(), secondary({ quoteMetadata }));
    const context = { statementHistory: "extended" as const, ...(contract ? { instrument } : {}) };
    try {
      const router = new AssetDataRouter(gloom, [cloud], persistence.resources);
      const value = await router.getTickerFinancials("JPM", "NYSE", context);
      expect(calls.gloom).toBe(1);
      expect(value.profile).toBeUndefined();
      const reopened = new AssetDataRouter(gloom, [cloud], persistence.resources).getCachedFinancialsForTargets([{ symbol: "JPM", exchange: "NYSE", ...context }]).get("JPM");
      expect(reopened?.profile).toBeUndefined();
      expect(reopened?.quote?.price).toBe(310);
    } finally { persistence.close(); }
  });
}

for (const warm of [false, true]) test(`${warm ? "cached" : "fresh"} deep batch statements still require missing profile enrichment`, async () => {
  const persistence = new AppPersistence(createTempDbPath(`profile-batch-${warm}`));
  const { cloud, gloom, calls } = providers();
  try {
    if (warm) cacheRouterResource(persistence.resources, "financials", "JPM", "exchange=NYSE", "provider:gloomberb-cloud", company(), cachePolicy);
    const router = new AssetDataRouter(gloom, [cloud], persistence.resources);
    const targets = [{ symbol: "JPM", exchange: "NYSE" }];
    expect((await router.getTickerFinancialsBatch(targets))[0]?.financials?.profile).toEqual(profile);
    expect(calls).toEqual({ cloud: 1, gloom: 1, batch: 1 });
    expect((await router.getTickerFinancialsBatch(targets))[0]?.financials?.profile).toEqual(profile);
    expect(calls).toEqual({ cloud: 1, gloom: 1, batch: 1 });
  } finally { persistence.close(); }
});

test("a complete bank profile uses no additional fallback request", async () => {
  const { cloud, gloom, calls } = providers(company({ profile }));
  const value = await new AssetDataRouter(gloom, [cloud]).getTickerFinancials("JPM", "NYSE", { statementHistory: "extended" });
  expect(value.profile).toEqual(profile);
  expect(calls).toEqual({ cloud: 1, gloom: 0, batch: 0 });
});

for (const mismatch of ["both-symbol", "both-venue", "secondary-metadata", "primary-metadata", "secondary-contribution"] as const) {
  test(`contract profile enrichment validates the requested listing before normalization: ${mismatch}`, async () => {
    const persistence = new AppPersistence(createTempDbPath(`profile-contract-${mismatch}`));
    const wrong = createTestQuote({ symbol: mismatch === "both-venue" ? "JPM" : "BAC", listingExchangeName: mismatch === "both-venue" ? "LSE" : "NYSE" });
    const both = mismatch.startsWith("both-");
    const cloudValue = company({ ...(both ? { quote: wrong } : {}), ...(mismatch === "primary-metadata" ? { quoteMetadata: quoteMetadataFromQuote(wrong) } : {}) });
    const gloomValue = secondary({
      ...(both || mismatch === "secondary-metadata" ? { quoteMetadata: quoteMetadataFromQuote(wrong) } : {}),
      ...(mismatch === "secondary-metadata" ? { quote: company().quote } : {}),
      ...(mismatch === "secondary-contribution" ? { quoteContributions: { gloom: wrong } } : {}),
    });
    const { cloud, gloom } = providers(cloudValue, gloomValue);
    try {
      const context = { statementHistory: "extended" as const, instrument };
      const result = await new AssetDataRouter(gloom, [cloud], persistence.resources).getTickerFinancials("JPM", "NYSE", context);
      expect(result.profile).toBeUndefined();
      const reopened = new AssetDataRouter(gloom, [cloud], persistence.resources).getCachedFinancialsForTargets([{ symbol: "JPM", exchange: "NYSE", ...context }]).get("JPM");
      expect(reopened?.profile).toBeUndefined();
    } finally { persistence.close(); }
  });
}

for (const mode of ["extended", "default", "batch"] as const) {
  test(`${mode} missing-profile attempts survive cache reopen, retry after a minute and allow explicit refresh`, async () => {
    const path = createTempDbPath(`profile-attempt-${mode}`);
    let persistence = new AppPersistence(path);
    const { cloud, gloom, calls } = providers();
    let recovered = false;
    gloom.getTickerFinancials = async () => { calls.gloom++; return secondary({ profile: recovered ? profile : undefined }); };
    const load = async (refresh = false) => {
      const router = new AssetDataRouter(gloom, [cloud], persistence.resources);
      return mode === "batch"
        ? (await router.getTickerFinancialsBatch([{ symbol: "JPM", exchange: "NYSE" }], { forceRefresh: refresh }))[0]!.financials!
        : router.getTickerFinancials("JPM", "NYSE", { ...(mode === "extended" ? { statementHistory: "extended" as const } : {}), cacheMode: refresh ? "refresh" : "default" });
    };
    try {
      expect((await load()).profile).toBeUndefined();
      persistence.close(); persistence = new AppPersistence(path);
      expect((await load()).profile).toBeUndefined();
      expect((await load()).profile).toBeUndefined();
      expect(calls).toEqual({ cloud: 1, gloom: 1, batch: mode === "batch" ? 1 : 0 });
      const later = Date.now() + 61_000;
      Date.now = () => later;
      expect((await load()).profile).toBeUndefined();
      expect(calls).toEqual({ cloud: 2, gloom: 2, batch: mode === "batch" ? 2 : 0 });
      recovered = true;
      expect((await load(true)).profile).toEqual(profile);
      expect(calls).toEqual({ cloud: 3, gloom: 3, batch: mode === "batch" ? 3 : 0 });
    } finally { persistence.close(); }
  });
}
