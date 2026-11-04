import { expect, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { listLookups, RequestAllowance } from "./batched-lookups";

test("an allowance makes a request wait for room in its sliding window, in the order asked, never refusing it", async () => {
  let now = 0;
  const slept: number[] = [];
  const allowance = new RequestAllowance(300, 60_000, () => now, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  await allowance.take(200);
  now = 10_000;
  await allowance.take(100);
  expect(slept).toEqual([]);
  // The window is full until the first 200 leave it, a minute after they went (and a second for the trip).
  await allowance.take(50);
  expect(now).toBe(61_000);
  // More than the whole allowance waits for an empty window (the 50 taken at 61 s leave it at 122 s).
  await allowance.take(1_000);
  expect(now).toBe(122_000);
});

test("a list's lookups ask each search and quote once, gather single asks into batches, and keep a signed-out allowance", async () => {
  const batches: string[][] = [];
  const quoted: string[] = [];
  const singles: string[] = [];
  const row = (symbol: string) => ({ providerId: "test", symbol, name: symbol, exchange: "NYSE", currency: "USD", type: "Common Stock" });
  const source = createTestDataProvider({
    search: async (query) => {
      singles.push(query);
      return [row(query)];
    },
    getQuote: async (symbol) => createTestQuote({ symbol }),
  });
  source.searchBatch = async (queries) => {
    batches.push([...queries]);
    return new Map(queries.map((query) => [query, query === "NONE" ? [] : [row(query)]]));
  };
  source.getQuotesBatch = async (targets) => {
    quoted.push(...targets.map((target) => target.symbol));
    return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
  };
  const spent: Array<[string, number]> = [];
  const allowance = (name: string) => ({ take: async (cost: number) => { spent.push([name, cost]); } }) as unknown as RequestAllowance;
  const lookups = listLookups(source, { allowances: { shared: allowance("shared"), listLookups: allowance("listLookups") } });

  await lookups.searchBatch!(["JPM", "WFC"], { limit: 10 });
  // Answered already, or gathered with the asks of the same moment into one batch; an empty answer is asked alone.
  const [jpm, bac, c, none] = await Promise.all(["JPM", "BAC", "C", "NONE"].map((query) => lookups.search(query)));
  expect([jpm, bac, c].map((rows) => rows[0]?.symbol)).toEqual(["JPM", "BAC", "C"]);
  expect(none).toEqual([row("NONE")]);
  expect(batches).toEqual([["JPM", "WFC"], ["BAC", "C", "NONE"]]);
  expect(singles).toEqual(["NONE"]);

  await lookups.getQuotesBatch!([{ symbol: "JPM", exchange: "NYSE" }, { symbol: "WFC", exchange: "NYSE" }]);
  // ALRS:NASDAQ on NASDAQ is ALRS there: one listing, quoted once.
  await lookups.getQuotesBatch!([{ symbol: "JPM", exchange: "NYSE" }, { symbol: "JPM:NYSE", exchange: "NYSE" }]);
  expect(await lookups.getQuote("WFC", "NYSE")).toMatchObject({ symbol: "WFC" });
  expect(quoted).toEqual(["JPM", "WFC"]);
  // Batched searches spend the list's own allowance, quotes and single searches the shared one.
  expect(spent).toEqual([["listLookups", 2], ["listLookups", 3], ["shared", 1], ["shared", 2]]);
});
