import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../api-client";
import { ApiRequestError } from "../api-client/errors";
import type { CloudQuotePayload } from "../api-client/types/quotes";
import { AppPersistence } from "../data/app-persistence";
import { AssetDataRouter } from "../sources/provider-router";
import { GloomberbCloudProvider } from "../sources/gloomberb-cloud";
import { quotesWithRetries } from "./quote-list-reads";

const originals = { getCloudQuote: apiClient.getCloudQuote, getCloudQuotesBatch: apiClient.getCloudQuotesBatch };
afterEach(() => Object.assign(apiClient, originals));

function payload(symbol: string): CloudQuotePayload {
  return {
    symbol, name: symbol, price: 10, currency: "USD", change: 0.1, changePercent: 1, previousClose: 9.9,
    lastUpdated: Date.now(), marketState: "REGULAR", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ",
    instrumentType: "Common Stock", providerId: "gloomberb-cloud", dataSource: "delayed",
  };
}

// A pasted list of 289 listings went out as one batch, which the service refuses past a hundred for a signed-out
// caller (413); every listing was then asked for alone, and the ones a busy moment left read "No quote provider".
test("a long list is quoted in batches the service takes, and a row refused for the moment is asked for again", async () => {
  const store = new AppPersistence(":memory:");
  const batches: number[] = [];
  let limited = true;
  apiClient.getCloudQuotesBatch = async (requests) => {
    batches.push(requests.length);
    if (requests.length > 100) throw new ApiRequestError("Anonymous market batch limit exceeded", 413);
    return { status: "success", data: { items: requests.map((request) => ({ ...request, exchange: request.exchange ?? "", status: "success" as const,
      data: payload(request.symbol) })) } };
  };
  // The listing asked for alone meets the request limit once.
  apiClient.getCloudQuote = async (symbol) => {
    if (symbol === "Z1" && limited) { limited = false; throw new ApiRequestError("Anonymous market rate limit exceeded", 429, 1_000); }
    return { status: "success", data: payload(symbol) };
  };
  try {
    const router = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    const targets = Array.from({ length: 250 }, (_, index) => ({ symbol: `S${index}`, exchange: "NASDAQ" }));
    const quoted = await router.getQuotesBatch(targets, { revalidate: true });
    expect(batches).toEqual([100, 100, 50]);
    expect(quoted.every((result) => result.quote?.price === 10)).toBe(true);

    // A batch the service could not answer leaves Z1 to be asked alone, which meets the limit: the row says so,
    // and the list asks for it again rather than printing it as unquoted.
    apiClient.getCloudQuotesBatch = async () => { throw new ApiRequestError("Service unavailable", 503); };
    const told: Array<[number, number]> = [];
    const asked: string[][] = [];
    const results = await quotesWithRetries([{ symbol: "Z1", exchange: "NASDAQ" }, { symbol: "Z2", exchange: "NASDAQ" }],
      (again) => { asked.push(again.map((target) => target.symbol)); return router.getQuotesBatch(again, { forceRefresh: true }); },
      { waitsMs: [0, 0], onRetry: (count, waitMs) => told.push([count, waitMs]) });
    expect(asked).toEqual([["Z1", "Z2"], ["Z1"]]);
    expect(told).toEqual([[1, 0]]);
    expect(results.map((result) => result.quote?.symbol)).toEqual(["Z1", "Z2"]);
    limited = true;
    const [refused] = await router.getQuotesBatch([{ symbol: "Z1", exchange: "NASDAQ" }], { forceRefresh: true });
    expect(refused!.error).toBe("Gloom's data service is at its request limit for Z1. Try again in 1 s.");

    // A source's own answer is kept: never asked again.
    const misses = await quotesWithRetries([{ symbol: "NOPE" }], async (again) => {
      asked.push(again.map((target) => target.symbol));
      return again.map((target) => ({ target, quote: null, error: "Not a ticker: NOPE." }));
    }, { waitsMs: [0, 0] });
    expect(asked.at(-1)).toEqual(["NOPE"]);
    expect(asked.filter((symbols) => symbols.includes("NOPE"))).toHaveLength(1);
    expect(misses[0]!.error).toBe("Not a ticker: NOPE.");
  } finally {
    store.close();
  }
});
