import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { apiClient } from "../api-client";
import { ApiRequestError } from "../api-client/errors";
import type { CloudQuotePayload } from "../api-client/types/quotes";
import { AppPersistence } from "../data/app-persistence";
import { AssetDataRouter } from "../sources/provider-router";
import { GloomberbCloudProvider } from "../sources/gloomberb-cloud";
import { DataServiceUnreachableError } from "../utils/network-failure";
import { quotesWithRetries } from "./quote-list-reads";

const originals = { getCloudQuote: apiClient.getCloudQuote, getCloudQuotesBatch: apiClient.getCloudQuotesBatch };
// The quotes below read REGULAR, which is current only while NASDAQ's regular session is: in its pre-market or after
// hours they lack the session's price, and every row is asked for again alone. Tue 10 Nov 2026, 10:00 in New York.
beforeEach(() => setSystemTime(new Date("2026-11-10T15:00:00Z")));
afterEach(() => {
  setSystemTime();
  Object.assign(apiClient, originals);
});

function payload(symbol: string): CloudQuotePayload {
  return {
    symbol, name: symbol, price: 10, currency: "USD", change: 0.1, changePercent: 1, previousClose: 9.9,
    lastUpdated: Date.now(), marketState: "REGULAR", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ",
    instrumentType: "Common Stock", providerId: "gloomberb-cloud", dataSource: "delayed",
  };
}

// A pasted list of 289 listings went out as one batch, which the service refuses past a hundred for a signed-out
// caller (413); every listing was then asked for alone, and the ones a busy moment left read "No quote provider".
test("a long list is quoted in batches the service takes, and a row the service did not answer is asked for again", async () => {
  const store = new AppPersistence(":memory:");
  const batches: number[] = [];
  // Each symbol here fails the first time it is asked for alone.
  const failing = new Set(["Z1"]);
  apiClient.getCloudQuotesBatch = async (requests) => {
    batches.push(requests.length);
    if (requests.length > 100) throw new ApiRequestError("Anonymous market batch limit exceeded", 413);
    return { status: "success", data: { items: requests.map((request) => ({ ...request, exchange: request.exchange ?? "", status: "success" as const,
      data: payload(request.symbol) })) } };
  };
  apiClient.getCloudQuote = async (symbol) => {
    if (failing.delete(symbol)) throw new DataServiceUnreachableError(new Error("socket hang up"));
    return { status: "success", data: payload(symbol) };
  };
  try {
    const router = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    const targets = Array.from({ length: 250 }, (_, index) => ({ symbol: `S${index}`, exchange: "NASDAQ" }));
    const quoted = await router.getQuotesBatch(targets, { revalidate: true });
    expect(batches).toEqual([100, 100, 50]);
    expect(quoted.every((result) => result.quote?.price === 10)).toBe(true);

    // A batch the service could not answer leaves Z1 to be asked alone, which fails too: the list asks for it again
    // rather than printing it as unquoted.
    apiClient.getCloudQuotesBatch = async () => { throw new ApiRequestError("Service unavailable", 503); };
    const told: Array<[number, number]> = [];
    const asked: string[][] = [];
    const results = await quotesWithRetries([{ symbol: "Z1", exchange: "NASDAQ" }, { symbol: "Z2", exchange: "NASDAQ" }],
      (again) => { asked.push(again.map((target) => target.symbol)); return router.getQuotesBatch(again, { forceRefresh: true }); },
      { waitsMs: [0, 0], onRetry: (count, waitMs) => told.push([count, waitMs]) });
    expect(asked).toEqual([["Z1", "Z2"], ["Z1"]]);
    expect(told).toEqual([[1, 0]]);
    expect(results.map((result) => result.quote?.symbol)).toEqual(["Z1", "Z2"]);

    // Asked a chunk at a time, each row told once it is final, so a long list's progress moves as each ask returns.
    const chunks: string[][] = [];
    const settled: string[][] = [];
    let busy = true;
    await quotesWithRetries(["C1", "C2", "C3"].map((symbol) => ({ symbol })), async (again) => {
      chunks.push(again.map((target) => target.symbol));
      return again.map((target) => target.symbol === "C1" && busy
        ? (busy = false, { target, quote: null, error: "Gloom's data service did not answer for C1. Try again in a moment." })
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

// A signed-out list of 1,000 meets the service's 600 quotes a minute: the rows past it were asked for again, and each
// refused batch was asked for one listing at a time, a request each, more of what the limit refused.
test("a list over the signed-out allowance quotes what it allows, and every row past it says when to try, asked for once", async () => {
  const store = new AppPersistence(":memory:");
  const ALLOWANCE = 600;
  let used = 0;
  const batches: Array<[number, number]> = [];
  let alone = 0;
  apiClient.getCloudQuotesBatch = async (requests) => {
    batches.push([requests.length, used]);
    if (used + requests.length > ALLOWANCE) throw new ApiRequestError("Anonymous market rate limit exceeded", 429, 42_000);
    used += requests.length;
    return { status: "success", data: { items: requests.map((request) => ({ ...request, exchange: request.exchange ?? "", status: "success" as const,
      data: payload(request.symbol) })) } };
  };
  apiClient.getCloudQuote = async (symbol) => { alone += 1; return { status: "success", data: payload(symbol) }; };
  try {
    const router = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    const targets = Array.from({ length: 1_000 }, (_, index) => ({ symbol: `L${index}`, exchange: "NASDAQ" }));
    const told: number[] = [];
    let rounds = 0;
    const results = await quotesWithRetries(targets, (asked) => { rounds += 1; return router.getQuotesBatch(asked, { revalidate: true }); },
      { waitsMs: [0, 0], onRetry: (count) => told.push(count) });
    expect(results.filter((result) => result.quote).length).toBe(ALLOWANCE);
    const refused = results.filter((result) => !result.quote);
    expect(refused).toHaveLength(400);
    expect(refused[0]!.error).toBe(`Gloom's data service is at its request limit for ${refused[0]!.target.symbol}. Try again in 42 s.`);
    expect(refused.every((result) => result.transient !== true)).toBe(true);
    // Ten requests of a hundred, and nothing more: no row asked for again, no listing asked for alone.
    expect(rounds).toBe(10);
    expect(told).toEqual([]);
    expect(alone).toBe(0);
    expect(batches).toHaveLength(10);

    // Asked as one call, the provider stops sending at the first refusal and keeps the batches it was answered.
    batches.length = 0;
    used = 450;
    const once = await router.getQuotesBatch(targets.slice(0, 500).map((target) => ({ ...target, symbol: `M${target.symbol}` })), { revalidate: true });
    expect(once.filter((result) => result.quote)).toHaveLength(100);
    expect(once.filter((result) => typeof result.error === "string" && result.error.includes("request limit"))).toHaveLength(400);
    // Three went out together (one answered, two refused); the last two were never sent.
    expect(batches).toHaveLength(3);
    expect(alone).toBe(0);
  } finally {
    store.close();
  }
});
