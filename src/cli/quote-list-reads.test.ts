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
  // Each symbol here meets the request limit the first time it is asked for alone.
  const limited = new Set(["Z1"]);
  apiClient.getCloudQuotesBatch = async (requests) => {
    batches.push(requests.length);
    if (requests.length > 100) throw new ApiRequestError("Anonymous market batch limit exceeded", 413);
    return { status: "success", data: { items: requests.map((request) => ({ ...request, exchange: request.exchange ?? "", status: "success" as const,
      data: payload(request.symbol) })) } };
  };
  // The listing asked for alone meets the request limit once.
  apiClient.getCloudQuote = async (symbol) => {
    if (limited.delete(symbol)) throw new ApiRequestError("Anonymous market rate limit exceeded", 429, 1_000);
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
    // A listing with no saved copy to answer for it (Z1's now has one).
    limited.add("Z9");
    const [refused] = await router.getQuotesBatch([{ symbol: "Z9", exchange: "NASDAQ" }], { forceRefresh: true });
    expect(refused!.error).toBe("Gloom's data service is at its request limit for Z9. Try again in 1 s.");

    // Asked a chunk at a time, each row told once it is final, so a long list's progress moves as each ask returns.
    const chunks: string[][] = [];
    const settled: string[][] = [];
    let busy = true;
    await quotesWithRetries(["C1", "C2", "C3"].map((symbol) => ({ symbol })), async (again) => {
      chunks.push(again.map((target) => target.symbol));
      return again.map((target) => target.symbol === "C1" && busy
        ? (busy = false, { target, quote: null, error: "Gloom's data service is at its request limit for C1. Try again in 1 s." })
        : { target, quote: { symbol: target.symbol } as never });
    }, { waitsMs: [0, 0], chunkSize: 2, onSettled: (rows) => settled.push(rows.map(({ result, index }) => `${index}:${result.target.symbol}`)) });
    expect(chunks).toEqual([["C1", "C2"], ["C3"], ["C1"]]);
    expect(settled).toEqual([["1:C2"], ["2:C3"], ["0:C1"]]);

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
