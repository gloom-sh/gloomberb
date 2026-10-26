import { useRegularMarketSession } from "../../test-support/market-session";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiClient } from "../../api-client";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { AssetDataRouter } from "./index";
import { FINANCIALS_SCHEMA_VERSION } from "./cache";
import { AppPersistence } from "../../data/app-persistence";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { mapQuote } from "../gloomberb-cloud/normalizers";
import { providerQuoteMatchesTarget } from "./financials";
import { quoteTradingExchange } from "../../market-data/quotes/metadata";

useRegularMarketSession();

const originals = { getCloudQuote: apiClient.getCloudQuote, getCloudFinancials: apiClient.getCloudFinancials, getCloudHistory: apiClient.getCloudHistory, getCloudQuotesBatch: apiClient.getCloudQuotesBatch, subscribeQuotes: apiClient.subscribeQuotes, ensureVerifiedSession: apiClient.ensureVerifiedSession };
afterEach(() => Object.assign(apiClient, originals));
const quote = (price = 3025) => ({ symbol: "7203", currency: "JPY", exchangeName: "JPX", listingExchangeName: "JPX", price, lastUpdated: Date.now(), marketState: "CLOSED", instrumentType: "EQUITY" });
const financials = (price = 3025) => ({ quote: quote(price), profile: { description: "Fixture issuer" }, annualStatements: [{ date: "2026-03-31", currency: "JPY", totalRevenue: 10 }], quarterlyStatements: [], priceHistory: [] });

function installCloud() {
  const calls: Array<[string, string, string | undefined]> = [];
  apiClient.getCloudQuote = (async (symbol: string, exchange: string) => { calls.push(["quote", symbol, exchange]); return { status: "success", data: quote() }; }) as any;
  apiClient.getCloudFinancials = (async (symbol: string, exchange: string) => { calls.push(["financials", symbol, exchange]); return { status: "success", data: financials() }; }) as any;
  apiClient.getCloudHistory = (async (symbol: string, exchange: string) => { calls.push(["history", symbol, exchange]); return { status: "success", providerMeta: { provider: "gloom" }, currency: "JPY", data: [{ date: "2026-09-10 10:00:00", close: 3025 }] }; }) as any;
  return calls;
}

test("bare suffix controls request, returned identity and naive timestamps across actual cloud and router", async () => {
  const calls = installCloud();
  const provider = new GloomberbCloudProvider();
  const store = new AppPersistence(":memory:");
  try {
    const router = new AssetDataRouter(provider, [], store.resources);
    for (const source of [provider, router]) {
      expect(await source.getQuote("7203.T", "TSE")).toMatchObject({ symbol: "7203.T", currency: "JPY", listingExchangeName: "JPX" });
      expect(await source.getQuoteMetadata("7203.T", "TSE")).toMatchObject({ currency: "JPY", listingExchangeName: "JPX" });
      expect((await source.getTickerFinancials("7203.T", "TSE")).quote?.currency).toBe("JPY");
      const points = await source.getDetailedPriceHistory("7203.T", "TSE", new Date("2026-09-01"), new Date("2026-09-11"), "1h");
      expect(points[0]?.date.toISOString()).toBe("2026-09-10T01:00:00.000Z");
    }
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every(([, symbol, exchange]) => symbol === "7203.T" && exchange === "JPX")).toBe(true);
  } finally { store.close(); }
});

test("old wrong-venue and unqualified caches cannot reintroduce Tokyo prices or timestamps under stale metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloom-alias-review-"));
  const path = join(dir, "cache.sqlite");
  const calls = installCloud();
  const policy = { staleMs: 60_000, expireMs: 600_000 };
  let store = new AppPersistence(path);
  try {
    for (const variantKey of ["exchange=TSX", ""]) store.resources.set({ namespace: "market", kind: "financials", entityKey: "7203.T", variantKey, sourceKey: "provider:gloomberb-cloud" }, financials(999), { schemaVersion: FINANCIALS_SCHEMA_VERSION, cachePolicy: policy });
    for (const variantKey of ["exchange=TSX;start=2026-09-01;end=2026-09-11;bar=1h;version=8", "start=2026-09-01;end=2026-09-11;bar=1h;version=8"]) store.resources.set({ namespace: "market", kind: "detailed-price-history", entityKey: "7203.T", variantKey, sourceKey: "provider:gloomberb-cloud" }, { points: [{ date: new Date("2026-09-10T14:00:00Z"), close: 999 }], resolution: "1h" }, { cachePolicy: policy });
    // Unrelated records must survive any targeted repair.
    store.resources.set({ namespace: "market", kind: "financials", entityKey: "UNRELATED", variantKey: "exchange=NYSE", sourceKey: "provider:gloomberb-cloud" }, { ...financials(777), quote: { ...quote(777), symbol: "UNRELATED", currency: "USD", exchangeName: "NYSE", listingExchangeName: "NYSE" } }, { schemaVersion: FINANCIALS_SCHEMA_VERSION, cachePolicy: policy });
    store.close(); store = new AppPersistence(path);
    const first = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    expect(first.getCachedFinancialsForTargets([{ symbol: "7203.T", exchange: "TSE" }]).get("7203.T")?.quote?.price).not.toBe(999);
    expect((await first.getTickerFinancials("7203.T", "TSE")).quote?.price).toBe(3025);
    const loadHistory = (router: AssetDataRouter) => router.getDetailedPriceHistory("7203.T", "TSE", new Date("2026-09-01"), new Date("2026-09-11"), "1h");
    expect((await loadHistory(first))[0]?.date.toISOString()).toBe("2026-09-10T01:00:00.000Z");
    expect(first.getCachedFinancialsForTargets([{ symbol: "UNRELATED", exchange: "NYSE" }]).get("UNRELATED")?.quote?.price).toBe(777);
    const beforeRestart = calls.length;
    store.close(); store = new AppPersistence(path);
    const reopened = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    expect(reopened.getCachedFinancialsForTargets([{ symbol: "7203.T", exchange: "TSE" }]).get("7203.T")?.quote?.price).toBe(3025);
    expect(new Date((await loadHistory(reopened))[0]!.date).toISOString()).toBe("2026-09-10T01:00:00.000Z");
    expect(calls.length).toBe(beforeRestart);
    expect(calls.every(([, symbol, exchange]) => symbol === "7203.T" && exchange === "JPX")).toBe(true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a futures listing on its venue code takes the quote that names the venue, and no other venue's", async () => {
  // Search and the futures board give the code (GC=F:CMX); the quote names the venue (COMEX).
  const venues: Record<string, string> = { "GC=F": "COMEX", "CL=F": "NY MERCANTILE", "ZC=F": "CBOT" };
  apiClient.getCloudQuote = (async (symbol: string) => ({ status: "success", data: {
    ...quote(), symbol, currency: "USD", exchangeName: venues[symbol], listingExchangeName: venues[symbol], instrumentType: "FUTURE",
  } })) as any;
  const store = new AppPersistence(":memory:");
  try {
    const router = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    for (const [symbol, exchange] of [["GC=F", "CMX"], ["CL=F", "NYM"], ["ZC=F", "CBT"], ["CL=F", "NYMEX"]] as const) {
      expect(await router.getQuote(symbol, exchange)).toMatchObject({ symbol, price: 3025 });
    }
    await expect(router.getQuote("GC=F", "NYM")).rejects.toThrow("No quote provider available");
  } finally { store.close(); }
});

test("declared contract contexts retain exact venue, contract and independent cache identity", async () => {
  const calls: unknown[] = [];
  const provider = createTestDataProvider({ getQuote: async (symbol, exchange, context) => {
    calls.push({ symbol, exchange, context });
    return { ...quote(context!.instrument!.conId!), symbol, exchangeName: "TSX", listingExchangeName: "TSX" };
  } });
  const store = new AppPersistence(":memory:");
  try {
    const router = new AssetDataRouter(provider, [], store.resources);
    const contexts = [100, 200].map(conId => ({ brokerId: "fixture", brokerInstanceId: "exact", instrument: { conId, symbol: "7203.T", brokerId: "fixture", brokerInstanceId: "exact", secType: "STK", exchange: "TSE", currency: "CAD" } }));
    for (const context of contexts) expect((await router.getQuote("7203.T", "TSE", context)).price).toBe(context.instrument.conId);
    expect(calls).toHaveLength(2);
    for (let i = 0; i < calls.length; i++) {
      expect((calls[i] as any).exchange).toBe("TSE");
      expect((calls[i] as any).context).toBe(contexts[i]);
      expect((calls[i] as any).context.instrument).toBe(contexts[i]!.instrument);
    }
  } finally { store.close(); }
});

test("bare suffix aliases keep caller identity through reordered cloud batches and routed streams", async () => {
  const targets: QuoteSubscriptionTarget[] = [
    { symbol: "7203.T", exchange: "TSE", surface: "detail", selected: true },
    { symbol: "RY", exchange: "TSE", surface: "portfolio", visible: true },
    { symbol: "7203.T:TSE", exchange: "JPX" },
  ];
  const items = [
    { symbol: "UNREQUESTED", exchange: "JPX", status: "success" as const, data: { ...quote(), symbol: "UNREQUESTED" } },
    { symbol: "RY", exchange: "TSX", status: "success" as const, data: { ...quote(), symbol: "RY", currency: "CAD", exchangeName: "TSX", listingExchangeName: "TSX" } },
    { symbol: "7203", exchange: "JPX", status: "success" as const, data: quote() },
  ];
  apiClient.getCloudQuotesBatch = async (requests) => {
    expect(requests).toEqual([{ symbol: "7203.T", exchange: "JPX" }, { symbol: "RY", exchange: "TSX" }]);
    return { status: "success", data: { items } };
  };
  apiClient.ensureVerifiedSession = async () => null;
  apiClient.subscribeQuotes = (requests, onQuote) => {
    expect(requests.map(({ symbol, exchange }) => ({ symbol, exchange })))
      .toEqual([{ symbol: "7203.T", exchange: "JPX" }, { symbol: "RY", exchange: "TSX" }]);
    for (const item of items) onQuote(item, item.data);
    return () => {};
  };
  const cloud = new GloomberbCloudProvider();
  for (const source of [cloud, new AssetDataRouter(cloud)]) {
    const batch = await source.getQuotesBatch(targets);
    expect(batch).toHaveLength(3);
    expect(batch.find((item) => item.target === targets[0])?.quote).toMatchObject({ symbol: "7203.T", currency: "JPY" });
    expect(batch.find((item) => item.target === targets[1])?.quote).toMatchObject({ symbol: "RY", currency: "CAD" });
    expect(batch.find((item) => item.target === targets[2])?.quote).toBeNull();
    const seen: QuoteSubscriptionTarget[] = [];
    source.subscribeQuotes(targets, (target, value) => { seen.push(target); expect(value.symbol).toBe(target.symbol); })();
    expect(seen[0]).toBe(targets[1]!);
    expect(seen[1]).toBe(targets[0]!);
  }
});

test("a row saved as 247540:KRX keeps Gloom Cloud's KOSDAQ quote, answered as KRX, by request, batch, stream and cache", async () => {
  // Gloom Cloud's answer for EcoPro BM, a KOSDAQ code a row saved before search listed it on KOSDAQ asks for on KRX:
  // its KOSDAQ quote under the listing asked for, naming the board it read. This listing check, and the cache's
  // below, are those of every release since v0.15 (unchanged in this code), so installed apps keep the answer.
  const answer = (listing = "KRX") => ({ symbol: "247540", name: "EcoPro BM Co., Ltd.", currency: "KRW", price: 128_800,
    lastUpdated: Date.now(), marketState: "CLOSED", instrumentType: "EQUITY", listingExchangeName: listing,
    listingExchangeFullName: listing, exchangeName: listing, fullExchangeName: listing, tradingExchangeName: "KOSDAQ" });
  for (const key of ["247540:KRX", "247540"]) {
    expect(providerQuoteMatchesTarget({ ...mapQuote(answer()), symbol: key }, key, "KRX"), key).toBe(true);
    // Named KOSDAQ, the same quote would be dropped.
    expect(providerQuoteMatchesTarget({ ...mapQuote(answer("KOSDAQ")), symbol: key }, key, "KRX"), key).toBe(false);
  }
  apiClient.getCloudQuote = (async () => ({ status: "success", data: answer() })) as any;
  apiClient.getCloudQuotesBatch = async (requests) => ({ status: "success", data: { items: requests.map((request) => ({
    ...request, status: "success" as const, data: answer() })) } });
  apiClient.ensureVerifiedSession = async () => null;
  apiClient.subscribeQuotes = (requests, onQuote) => {
    for (const request of requests) onQuote(request, answer());
    return () => {};
  };
  const saved = { price: 128_800, listingExchangeName: "KRX", tradingExchangeName: "KOSDAQ" };
  const target: QuoteSubscriptionTarget = { symbol: "247540", exchange: "KRX", surface: "watchlist", visible: true };
  const store = new AppPersistence(":memory:");
  try {
    const router = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    const quoted = await router.getQuote("247540", "KRX");
    expect(quoted).toMatchObject(saved);
    expect(quoteTradingExchange(quoted)).toBe("KOSDAQ");
    expect((await router.getQuotesBatch([target]))[0]?.quote).toMatchObject(saved);
    const streamed: Quote[] = [];
    router.subscribeQuotes([target], (_target, quote) => streamed.push(quote))();
    expect(streamed[0]).toMatchObject(saved);
    // The cached answer is served again with the source gone.
    apiClient.getCloudQuote = (async () => { throw new Error("Cloud is down"); }) as any;
    apiClient.getCloudQuotesBatch = (async () => { throw new Error("Cloud is down"); }) as any;
    expect((await new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources).getQuotesBatch([target]))[0]?.quote)
      .toMatchObject(saved);
  } finally { store.close(); }
  // The same quote named KOSDAQ is one the router drops.
  apiClient.getCloudQuote = (async () => ({ status: "success", data: answer("KOSDAQ") })) as any;
  const other = new AppPersistence(":memory:");
  try {
    await expect(new AssetDataRouter(new GloomberbCloudProvider(), [], other.resources).getQuote("247540", "KRX"))
      .rejects.toThrow("No quote provider available");
  } finally { other.close(); }
});
