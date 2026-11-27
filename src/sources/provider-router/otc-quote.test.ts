import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { apiClient, type CloudQuotePayload } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import { AppPersistence } from "../../data/app-persistence";
import { getRegularSessionDisplay, quoteSessionLabel } from "../../market-data/market/status";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { AssetDataRouter } from "./index";

const originalQuote = apiClient.getCloudQuote;
const originalFinancials = apiClient.getCloudFinancials;
const venue = "OTC MARKETS OTCQX";
const close = Date.parse("2026-11-25T21:00:00Z");
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
