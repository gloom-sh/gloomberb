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

test("a batched search refused for one chunk drops the chunks still waiting for the allowance: nothing is sent after, nothing holds the command", async () => {
  const sent: number[] = [];
  const queries = Array.from({ length: 250 }, (_, index) => `Q${index}`);
  const source = createTestDataProvider({ search: async () => [] });
  source.searchBatch = async (chunk) => {
    sent.push(chunk.length);
    throw Object.assign(new Error("Anonymous market rate limit exceeded"), { status: 429 });
  };
  // A minute's allowance of 120: the first chunk goes at once, the others wait for the window, on real timers.
  const listAllowance = new RequestAllowance(120, 60_000);
  const lookups = listLookups(source, { allowances: { shared: new RequestAllowance(280, 60_000), listLookups: listAllowance } });
  const started = Date.now();
  await expect(lookups.searchBatch!(queries, { limit: 10 })).rejects.toThrow("rate limit");
  // The waiting chunks were dropped, not sent a minute later; the allowance's next taker is not held behind them.
  await listAllowance.take(1);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(sent).toEqual([100]);
});
