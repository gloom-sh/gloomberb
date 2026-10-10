import { expect, test } from "bun:test";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../types/data-provider";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { buildSearchReport } from "./search";
import { marketDataCliCommands } from "./market";

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

/** A quote source that answers only the listing keys in `quoted`, and records what each batch asked for. */
function venueSource(symbol: string, venues: string[], quoted: Record<string, ReturnType<typeof createTestQuote>>) {
  const batches: string[][] = [];
  let searches = 0;
  const dataProvider = createTestDataProvider({
    search: async () => {
      searches += 1;
      return venues.map((exchange) => ({ providerId: "test", symbol, name: `${symbol} Fund`, exchange, type: "ETF", currency: "EUR" }));
    },
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      batches.push(targets.map((target) => target.symbol));
      return targets.map((target) => quoted[target.symbol]
        ? { target, quote: quoted[target.symbol]! }
        : { target, quote: null, error: `No quote provider available for ${target.symbol}` });
    },
  });
  return { dataProvider, batches, searches: () => searches };
}

async function runQuote(args: string[], source: ReturnType<typeof venueSource>) {
  const cli = createTestCliContext({ dataProvider: source.dataProvider });
  let failure: { message: string; details?: string } | null = null;
  cli.context.fail = (message: string, details?: string): never => {
    failure = { message, details };
    throw new Error(message);
  };
  await quoteCommand.execute(args, cli.context).catch(() => {});
  const printed = cli.printed[0] as PrintedCliResult | undefined;
  return {
    failure: failure as { message: string; details?: string } | null,
    rows: (printed?.result.data ?? []) as Array<{ target: QuoteSubscriptionTarget; quote: unknown }>,
    warnings: printed?.result.warnings ?? [],
  };
}

test("a bare symbol with no quote is asked on the venue it resolved to, then its other listings in search order; a named venue never switches", async () => {
  const quote = createTestQuote({ symbol: "CSPX", currency: "EUR" });
  const source = venueSource("CSPX", ["XETRA", "LSE", "AMS"], { "CSPX:LSE": quote, "CSPX:AMS": { ...quote, price: 2 } });

  const bare = await runQuote(["CSPX"], source);
  // The bare request, then the venue it resolved to on its own, then the rest together.
  expect(source.batches).toEqual([["CSPX"], ["CSPX:XETRA"], ["CSPX:LSE", "CSPX:AMS"]]);
  // The first listing in search order with a quote wins, and the output names it.
  expect(bare.rows.map((row) => row.target.symbol)).toEqual(["CSPX:LSE"]);
  expect(bare.warnings[0]).toContain("CSPX -> LSE");

  // The listing it resolved to answers by key: nothing else is asked.
  const first = venueSource("CSPX", ["XETRA", "LSE"], { "CSPX:XETRA": quote, "CSPX:LSE": quote });
  expect((await runQuote(["CSPX"], first)).rows.map((row) => row.target.symbol)).toEqual(["CSPX:XETRA"]);
  expect(first.batches).toEqual([["CSPX"], ["CSPX:XETRA"]]);

  // XETRA was named, so its missing quote stays its own.
  source.batches.length = 0;
  const named = await runQuote(["CSPX:XETRA"], source);
  expect(source.batches).toEqual([["CSPX:XETRA"]]);
  expect(named.rows.map((row) => [row.target.symbol, row.quote])).toEqual([["CSPX:XETRA", null]]);

  // A request that succeeds pays for no search.
  const quotedBare = venueSource("CSPX", ["XETRA"], { CSPX: quote });
  await runQuote(["CSPX"], quotedBare);
  expect(quotedBare.searches()).toBe(0);
});

test("a bare index root points at its ^ index, whether it found nothing or another instrument", async () => {
  const none = await runQuote(["VIX"], venueSource("VIX", [], {}));
  expect(none.failure?.details).toContain("gloomberb quote ^VIX");

  const corvex = createTestQuote({ symbol: "MOVE", name: "Corvex, Inc.", instrumentType: "EQUITY" });
  const other = venueSource("MOVE", ["NASDAQ"], { MOVE: corvex, "MOVE:NASDAQ": corvex, "^MOVE": { ...corvex, instrumentType: "INDEX" } });
  expect((await runQuote(["MOVE"], other)).warnings.join("\n")).toContain("^MOVE");
  // A named listing and the index itself need no pointer.
  expect((await runQuote(["MOVE:NASDAQ"], other)).warnings).toEqual([]);
  expect((await runQuote(["^MOVE"], other)).warnings).toEqual([]);

  expect(buildSearchReport({ query: "vix", candidates: [] })).toContain("gloomberb quote ^VIX");
  expect(buildSearchReport({ query: "AAPL", candidates: [] })).not.toContain("^");
});
