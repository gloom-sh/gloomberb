import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { apiClient, type CloudQuotePayload } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import { AppPersistence } from "../../data/app-persistence";
import { getRegularSessionDisplay, quoteSessionLabel } from "../../market-data/market/status";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { cacheRouterResource, listCachedResources } from "./cache";
import { AssetDataRouter } from "./index";

const originalQuote = apiClient.getCloudQuote;
const originalFinancials = apiClient.getCloudFinancials;
const venue = "OTC MARKETS OTCQX";
const close = Date.parse("2026-11-25T21:00:00Z");
const policy = { staleMs: 60_000, expireMs: 120_000 };
const accounts = {
  profile: { name: "Example Trust" },
  annualStatements: [{ date: "2025-12-31", totalAssets: 100 }],
  quarterlyStatements: [],
  priceHistory: [{ date: new Date(close), close: 17.711 }],
};

function closedQuote(symbol: string, overrides: Partial<CloudQuotePayload> = {}): CloudQuotePayload {
  return {
    symbol, currency: "USD", exchangeName: venue, listingExchangeName: venue,
    price: 17.711, marketState: "CLOSED", providerId: "gloomberb-cloud", dataSource: "delayed", stale: false,
    lastUpdated: close, previousClose: 17.98, change: -0.269, changePercent: -1.496106785,
    changeSessionDate: "2026-11-25", ...overrides,
  };
}

beforeEach(() => {
  setSystemTime(new Date("2026-11-27T01:00:00Z"));
  apiClient.getCloudFinancials = async () => ({ status: "success", data: accounts });
});

afterEach(() => {
  apiClient.getCloudQuote = originalQuote;
  apiClient.getCloudFinancials = originalFinancials;
  setSystemTime();
});

test.each(["OTC", "OTCQX", "OQX", venue])("research on %s keeps the independently quoted regular close", async (exchange) => {
  const persistence = new AppPersistence(":memory:");
  const router = new AssetDataRouter(new GloomberbCloudProvider(), [], persistence.resources);
  const requests: Array<[string, string | undefined]> = [];
  apiClient.getCloudQuote = async (symbol, requestedVenue) => {
    requests.push([symbol, requestedVenue]);
    return { status: "success", data: closedQuote(symbol) };
  };
  try {
    const financials = await router.getTickerFinancials("EXMPL", exchange);
    expect(financials.quote).toMatchObject({ listingExchangeName: venue, marketState: "CLOSED", stale: false, lastUpdated: close });
    expect(isQuoteStaleForCurrentSession(financials.quote!)).toBe(false);
    expect(quoteSessionLabel(financials.quote)).toBe("CLOSED");
    const display = getRegularSessionDisplay(financials.quote);
    expect(display?.price).toBe(17.711);
    expect(display!.change!).toBeCloseTo(-0.269, 8);
    expect(display!.changePercent!).toBeCloseTo(-1.496106785, 8);
    expect(await router.getQuote("EXMPL", exchange)).toMatchObject({ price: 17.711, listingExchangeName: venue });
    expect(requests).toEqual([["EXMPL", exchange]]);
  } finally {
    persistence.close();
  }
});

test.each([
  ["OTC", "OTC MARKETS OTCID"], ["OTC", "OTC MARKETS OTCPK"], ["OTHER OTC", venue],
  ["OTCID", "OID"], ["OTCQB", "OQB"], ["PNK", "PINK SHEETS"], ["PINX", "OTCPK"],
  ["OBB", "OTCBB"], ["OTCBB", "NASDAQ OTCBB"], ["OEM", "EXMKT"], ["EXPM", "OEM"],
])("a %s request accepts a %s listing without rewriting its venue", async (exchange, listingExchangeName) => {
  const provider = new GloomberbCloudProvider();
  apiClient.getCloudQuote = async (symbol) => ({ status: "success", data: closedQuote(symbol, { listingExchangeName }) });
  expect(await provider.getQuote("EXMPL", exchange)).toMatchObject({ price: 17.711, listingExchangeName });
});

test.each([
  ["OTCQX", "EXMPL", "OTC"], ["OTCQX", "EXMPL:OTC", "OTHER OTC"], ["OTCQX", "EXMPL", ""],
  ["OTCQB", "EXMPL", venue], ["OTCQX", "EXMPL", "OTC MARKETS OTCPK"],
  ["OTCQX", "EXMPL:OTCID", "OTC"], ["OTC", "EXMPL:OTCQB", venue],
  ["OTC", "EXMPL", "OTC MARKETS UNKNOWN"],
])("a %s request rejects %s with venue %s at transport and cache boundaries", async (exchange, symbol, listingExchangeName) => {
  const store = new AppPersistence(":memory:");
  const cloud = new GloomberbCloudProvider();
  const quote = closedQuote(symbol, { listingExchangeName, exchangeName: listingExchangeName });
  apiClient.getCloudQuote = async () => ({ status: "success", data: quote });
  try {
    await expect(cloud.getQuote(`EXMPL:${exchange}`)).rejects.toThrow();
    const variant = `exchange=${exchange}`;
    const source = "provider:gloomberb-cloud";
    cacheRouterResource(store.resources, "quote", "EXMPL", variant, source, quote, policy);
    cacheRouterResource(store.resources, "financials", "EXMPL", variant, source, { ...accounts, quote }, policy);
    for (const kind of ["quote", "financials"]) {
      expect(listCachedResources(store.resources, kind, "EXMPL", [variant, ""], [source], true)).toEqual([]);
    }
  } finally { store.close(); }
});

test.each(["independent", "embedded"])("%s suffix-only tier proof survives a generic key and cache reuse", async (source) => {
  const store = new AppPersistence(":memory:");
  const cloud = new GloomberbCloudProvider();
  const router = new AssetDataRouter(cloud, [], store.resources);
  const quote = closedQuote("EXMPL:OQX", { listingExchangeName: "OTC", exchangeName: "OTC" });
  let requests = 0;
  apiClient.getCloudQuote = async () => {
    requests++;
    return { status: "success", data: quote };
  };
  if (source === "embedded") apiClient.getCloudFinancials = async () => ({ status: "success", data: { ...accounts, quote } });
  try {
    expect((await router.getTickerFinancials("EXMPL", "OTCQX")).quote).toMatchObject({ symbol: quote.symbol, listingExchangeName: "OTC" });
    expect(router.getCachedFinancialsForTargets([{ symbol: "EXMPL", exchange: "OTCQX" }]).get("EXMPL")?.quote)
      .toMatchObject({ symbol: quote.symbol, listingExchangeName: "OTC", price: 17.711 });
    expect(await cloud.getQuote("EXMPL:OTC")).toMatchObject({ symbol: quote.symbol, listingExchangeName: "OTC" });
    expect(requests).toBe(source === "independent" ? 2 : 1);
  } finally { store.close(); }
});

test("a tier named by exchangeName can confirm a generic symbol suffix", async () => {
  const cloud = new GloomberbCloudProvider();
  const quote = closedQuote("EXMPL:OTC", { listingExchangeName: undefined, exchangeName: venue });
  apiClient.getCloudQuote = async () => ({ status: "success", data: quote });
  expect(await cloud.getQuote("EXMPL:OTCQX")).toMatchObject({ symbol: quote.symbol, listingExchangeName: venue, price: 17.711 });
});

test("an embedded quote or cached metadata cannot borrow the requested tier from its key", async () => {
  const store = new AppPersistence(":memory:");
  const cloud = new GloomberbCloudProvider();
  const router = new AssetDataRouter(cloud, [], store.resources);
  apiClient.getCloudFinancials = async () => ({ status: "success", data: {
    ...accounts, quote: closedQuote("EXMPL:OTCQB", { listingExchangeName: "OTC", exchangeName: "OTC" }),
  } });
  apiClient.getCloudQuote = async () => { throw new ApiRequestError("Quote unavailable", 403); };
  try {
    const symbol = "EXMPL:OTCQX";
    await expect(router.getTickerFinancials(symbol)).rejects.toThrow();
    const cacheSource = "provider:gloomberb-cloud";
    cacheRouterResource(store.resources, "financials", symbol, "", cacheSource,
      { ...accounts, quoteMetadata: { listingExchangeName: "OTC" } }, policy);
    expect(listCachedResources(store.resources, "financials", symbol, [""], [cacheSource], true)).toEqual([]);
  } finally { store.close(); }
});

test("OTC research does not turn a bar, gated price, or different listing into a quote", async () => {
  const router = new AssetDataRouter(new GloomberbCloudProvider(), []);
  apiClient.getCloudQuote = async (symbol) => {
    if (symbol === "GATED") throw new ApiRequestError("Quote unavailable", 403);
    if (symbol === "NOPRICE") {
      const { price: _price, ...data } = closedQuote(symbol);
      return { status: "success", data: data as CloudQuotePayload };
    }
    return { status: "success", data: symbol === "CONFLICT"
      ? closedQuote(symbol, { symbol: "CONFLICT:OTCQX", listingExchangeName: "OTC" })
      : closedQuote(symbol, { listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" }) };
  };
  for (const [symbol, exchange] of [["NOPRICE", "OTC"], ["GATED", "OTC"], ["LISTED", "OTC"], ["CONFLICT", "OTCQB"]] as const) {
    const financials = await router.getTickerFinancials(symbol, exchange);
    expect(financials.profile?.name).toBe("Example Trust");
    expect(financials.priceHistory).toHaveLength(1);
    expect(getRegularSessionDisplay(financials.quote)).toBeNull();
  }
});

test("financials with an embedded OTC quote and its listing metadata retain their identity", async () => {
  const router = new AssetDataRouter(new GloomberbCloudProvider(), []);
  apiClient.getCloudFinancials = async (symbol) => ({ status: "success", data: {
    ...accounts, quote: closedQuote(symbol), quoteMetadata: { symbol, listingExchangeName: "OTC", source: {} },
  } });
  apiClient.getCloudQuote = async () => { throw new Error("No independent quote"); };
  const financials = await router.getTickerFinancials("EXMPL", "OTC");
  expect(financials.quote).toMatchObject({ price: 17.711, listingExchangeName: venue });
  expect(financials.annualStatements[0]?.totalAssets).toBe(100);
});

test("OTC research retains the source's stale flag on the last known close", async () => {
  const router = new AssetDataRouter(new GloomberbCloudProvider(), []);
  apiClient.getCloudQuote = async (symbol) => ({ status: "success", data: closedQuote(symbol, { stale: true }) });
  const { quote } = await router.getTickerFinancials("EXMPL", "OTC");
  expect(quote).toMatchObject({ price: 17.711, stale: true, lastUpdated: close, marketState: "CLOSED" });
  expect(isQuoteStaleForCurrentSession(quote!)).toBe(true);
  expect(getRegularSessionDisplay(quote)!.change!).toBeCloseTo(-0.269, 8);
});
