import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { apiClient } from "../../api-client";
import { resetFuturesPriceUnits } from "../../market-data/futures-contract";
import type { DataProvider, QuoteBatchResult, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { TickerChanges } from "../../types/ticker-changes";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { captureConsole } from "../../test-support/console";
import { createTestTicker } from "../../test-support/ticker";
import { resetBoardCoins } from "../board-coins";
import { withSearchHints } from "../not-a-ticker";
import { buildSearchReport, search } from "./search";
import { marketDataCliCommands } from "./market";

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

beforeEach(() => {
  resetFuturesPriceUnits();
  resetBoardCoins([]);
  spyOn(apiClient, "getCloudFuturesContract").mockRejectedValue(new Error("Fixture has no contract terms"));
});

// A quote that finds nothing sets the exit status; it must not become the test run's.
afterEach(() => {
  process.exitCode = 0;
  resetFuturesPriceUnits();
  resetBoardCoins();
  mock.restore();
});

/**
 * A quote source that answers only the listing keys in `quoted`, and records what each batch asked for.
 * Search lists the symbol on each venue under the company in `names`, else one fund.
 */
function venueSource(
  symbol: string,
  venues: string[],
  quoted: Record<string, ReturnType<typeof createTestQuote>>,
  names: Record<string, string> = {},
) {
  const batches: string[][] = [];
  let searches = 0;
  const dataProvider = createTestDataProvider({
    search: async () => {
      searches += 1;
      return venues.map((exchange) => ({ providerId: "test", symbol, name: names[exchange] ?? `${symbol} Fund`, exchange, type: "ETF", currency: "EUR" }));
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

  // A request that succeeds asks search only whether several companies list the bare symbol; one company says nothing.
  const quotedBare = venueSource("CSPX", ["XETRA"], { CSPX: quote });
  expect((await runQuote(["CSPX"], quotedBare)).warnings).toEqual([]);
  expect(quotedBare.batches).toEqual([["CSPX"]]);

  // With no quote anywhere, the listings just asked are named as having none, never offered as one to try.
  const unquoted = await runQuote(["CSPX"], venueSource("CSPX", ["XETRA", "LSE"], {}));
  expect(unquoted.failure?.message).toBe("CSPX resolved to CSPX Fund (XETRA), which has no quote.");
  expect(unquoted.failure?.details).toBe("No quote on its other listings either: CSPX:LSE.");
});

test("a listing whose quote request failed, rather than found none, is still one to try, under the symbol search lists it by", async () => {
  // `BARC.` is London's way to write BARC: search lists it as BARC on each venue.
  const listing = (exchange: string) => ({ providerId: "test", symbol: "BARC", name: "Barclays PLC", exchange, type: "Common Stock", currency: "GBP" });
  const source = (answer: (symbol: string) => QuoteBatchResult["quote"] | "timeout") => createTestDataProvider({
    search: async () => [listing("LSE"), listing("XETRA")],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => {
      const quote = answer(target.symbol);
      if (quote === "timeout") return { target, quote: null, error: "Request timed out" };
      return quote ? { target, quote } : { target, quote: null, error: `No quote provider available for ${target.symbol}` };
    }),
  });
  const failed = await runQuote(["BARC."], { dataProvider: source((symbol) => symbol === "BARC:XETRA" ? "timeout" : null), batches: [], searches: () => 0 });
  expect(failed.failure?.details).toBe("Other listings: BARC:XETRA Barclays PLC (try: gloom quote BARC:XETRA)");

  const quote = createTestQuote({ symbol: "BARC:LSE", currency: "GBP" });
  const quoted = await runQuote(["BARC."], { dataProvider: source((symbol) => symbol === "BARC:LSE" ? quote : null), batches: [], searches: () => 0 });
  expect(quoted.rows.map((row) => row.target.symbol)).toEqual(["BARC:LSE"]);
});

test("a code several companies list is never quoted on one of them: it asks for an exchange, and only its row fails", async () => {
  const quote = createTestQuote({ symbol: "2222", currency: "JPY" });
  const names = { JPX: "Kotobuki Spirits Co., Ltd.", TADAWUL: "Saudi Arabian Oil Co." };
  // Both listings have a quote, and the first in search order is not the answer.
  const source = venueSource("2222", ["JPX", "TADAWUL"], { "2222:JPX": quote, "2222:TADAWUL": { ...quote, price: 2 }, CSPX: quote }, names);

  const alone = await runQuote(["2222"], source);
  expect(alone.failure?.message).toBe("Choose an exchange for 2222.");
  expect(alone.failure?.details).toContain("2222:JPX Kotobuki Spirits Co., Ltd. (try: gloom quote 2222:JPX)");
  expect(alone.failure?.details).toContain("2222:TADAWUL Saudi Arabian Oil Co. (try: gloom quote 2222:TADAWUL)");
  // No listing was asked for its quote.
  expect(source.batches).toEqual([["2222"]]);

  // Beside others it is one failed row; the rest still print.
  const several = await runQuote(["2222", "CSPX"], source);
  expect(several.failure).toBeNull();
  expect(several.rows.map((row) => [row.target.symbol, row.quote == null])).toEqual([["2222", true], ["CSPX", false]]);
  expect((several.rows[0] as { error?: string }).error).toBe("Choose an exchange for 2222. Listings: 2222:JPX, 2222:TADAWUL.");
  expect(several.warnings.join("\n")).not.toContain("2222 ->");

  // A named listing is its own answer.
  expect((await runQuote(["2222:TADAWUL"], source)).rows.map((row) => [row.target.symbol, row.quote == null])).toEqual([["2222:TADAWUL", false]]);
});

test("BDI asks for an exchange and says the Baltic Dry Index is not covered; on an exchange it is Black Diamond Group's quote", async () => {
  const quote = createTestQuote({ symbol: "BDI:TSX", currency: "CAD" });
  const names = { TSX: "Black Diamond Group Limited", BSE: "B. D. Industries (Pune) Limited" };
  const source = venueSource("BDI", ["TSX", "BSE"], { "BDI:TSX": quote }, names);

  const bare = await runQuote(["BDI"], source);
  expect(bare.failure?.message).toBe("Choose an exchange for BDI.");
  expect(bare.failure?.details).toContain("BDI:TSX Black Diamond Group Limited (try: gloom quote BDI:TSX)");
  expect(bare.failure?.details).toContain("Baltic indices (BDI, Capesize, Panamax, Supramax) and freight forwards (FFA) are not covered.");

  const named = await runQuote(["BDI:TSX"], source);
  expect(named.failure).toBeNull();
  expect(named.rows.map((row) => [row.target.symbol, row.quote == null])).toEqual([["BDI:TSX", false]]);
  expect(named.warnings.join("\n")).not.toContain("Baltic");
});

test("a bare symbol the service read on its home listing abroad names the venue", async () => {
  const listed = (symbol: string, exchangeName: string, currency = "USD") => createTestQuote({ symbol, exchangeName, listingExchangeName: exchangeName, currency });
  const source = venueSource("SXR8", ["XETRA", "BUD"], {
    SXR8: listed("SXR8", "XETRA", "EUR"),
    "SXR8:XETRA": listed("SXR8", "XETRA", "EUR"),
    AAPL: listed("AAPL", "NASDAQ"),
    TCEHY: listed("TCEHY", "OTC MARKETS OTCPK"),
    CL1: listed("CL1", "NY MERCANTILE"),
    "^GDAXI": listed("^GDAXI", "XETRA", "EUR"),
  });

  const bare = await runQuote(["SXR8"], source);
  expect(bare.rows.map((row) => row.target.symbol)).toEqual(["SXR8"]);
  expect(bare.warnings).toEqual(["SXR8 -> XETRA"]);
  // A named venue, a US or OTC listing, a futures venue and an index say nothing more.
  for (const symbol of ["SXR8:XETRA", "AAPL", "TCEHY", "CL1", "^GDAXI"]) {
    expect((await runQuote([symbol], source)).warnings).toEqual([]);
  }
});

test("a bare symbol read abroad that is one slip from a US ticker says so beside the quote, and a deliberate one says nothing", async () => {
  const listed = (symbol: string, exchangeName: string, currency: string, name: string) => createTestQuote({ symbol, name, exchangeName, listingExchangeName: exchangeName, currency });
  const stock = (symbol: string, name: string, exchange: string, currency: string) => ({ providerId: "test", symbol, name, exchange, type: "EQUITY", currency });
  const dataProvider = createTestDataProvider({
    search: async (query: string) => ({
      APPL: [stock("APPL", "Aptus Pharma Limited", "BSE", "INR")],
      AAPL: [stock("AAPL", "Apple Inc.", "NASDAQ", "USD")],
      "7203": [stock("7203", "Toyota Motor Corporation", "JPX", "JPY")],
    })[query] ?? [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => ({
      target,
      quote: ({
        APPL: listed("APPL", "BSE", "INR", "Aptus Pharma Limited"),
        "APPL:BSE": listed("APPL", "BSE", "INR", "Aptus Pharma Limited"),
        AAPL: listed("AAPL", "NASDAQ", "USD", "Apple Inc."),
        "7203.T": listed("7203.T", "JPX", "JPY", "Toyota Motor Corporation"),
      } as Record<string, ReturnType<typeof createTestQuote>>)[target.symbol] ?? null,
    })),
  });
  const run = async (symbol: string, saved?: unknown) => {
    const cli = createTestCliContext({ dataProvider, store: { loadTicker: async () => saved ?? null, loadAllTickers: async () => [] } });
    await quoteCommand.execute([symbol], cli.context);
    const { result, options } = cli.printed[0]!;
    return { row: result.data[0], details: options?.details?.(result.data) ?? "" };
  };

  const typo = await run("APPL");
  // On stdout beside the table, and in the JSON row, not only the venue warning.
  expect(typo.details).toContain("APPL is not a US ticker: it is Aptus Pharma Limited on BSE (INR). Did you mean AAPL (Apple Inc.)?");
  expect(typo.row.usSuggestion).toEqual({ symbol: "AAPL", name: "Apple Inc." });
  // A venue the person named, a ticker with its suffix and a US listing are deliberate.
  for (const symbol of ["APPL:BSE", "7203.T", "AAPL"]) {
    const quiet = await run(symbol);
    expect(quiet.details).toBe("");
    expect(quiet.row.usSuggestion).toBeUndefined();
  }
});

test("a futures board code quotes its future where no security uses it, and names the future where the security has no quote", async () => {
  const ttf = venueSource("TTF", [], { "TTF=F": createTestQuote({ symbol: "TTF=F", currency: "EUR", instrumentType: "FUTURE" }) });
  expect((await runQuote(["TTF"], ttf)).rows.map((row) => row.target.symbol)).toEqual(["TTF=F"]);
  expect(ttf.batches).toEqual([["TTF=F"]]);

  // GC is several companies' code: it still asks for an exchange, and the future is one more choice.
  const names = { CSE: "Goldcana Resources Inc.", SET: "Global Connections Public Company Limited" };
  const gc = await runQuote(["GC"], venueSource("GC", ["CSE", "SET"], {}, names));
  expect(gc.failure?.message).toBe("Choose an exchange for GC.");
  expect(gc.failure?.details).toContain("GC=F Gold future (try: gloom quote GC=F)");
  // With no listing search knows, the future is still named.
  expect((await runQuote(["ES"], venueSource("ES", [], {}))).failure?.details).toBe("ES=F E-Mini S&P 500 future (try: gloom quote ES=F)");
  // A security that quotes keeps its code and says nothing of the future.
  const nova = await runQuote(["NG"], venueSource("NG", ["AMEX"], { NG: createTestQuote({ symbol: "NG", name: "NovaGold Resources Inc." }) }));
  expect([nova.rows.map((row) => row.target.symbol), nova.warnings]).toEqual([["NG"], []]);
});

test("a bare index root points at its ^ index, whether it found nothing or another instrument", async () => {
  const none = await runQuote(["VIX"], venueSource("VIX", [], {}));
  expect(none.failure?.details).toContain("gloom quote ^VIX");

  const corvex = createTestQuote({ symbol: "MOVE", name: "Corvex, Inc.", instrumentType: "EQUITY" });
  const other = venueSource("MOVE", ["NASDAQ"], { MOVE: corvex, "MOVE:NASDAQ": corvex, "^MOVE": { ...corvex, instrumentType: "INDEX" } });
  expect((await runQuote(["MOVE"], other)).warnings.join("\n")).toContain("^MOVE");
  // A named listing and the index itself need no pointer.
  expect((await runQuote(["MOVE:NASDAQ"], other)).warnings).toEqual([]);
  expect((await runQuote(["^MOVE"], other)).warnings).toEqual([]);

  expect(buildSearchReport({ query: "vix", candidates: [] })).toContain("gloom quote ^VIX");
  expect(buildSearchReport({ query: "AAPL", candidates: [] })).not.toContain("^");
});

test("a quote that stopped years ago says since when, keeps its last price, and takes the saved name when it has none", async () => {
  const lastTrade = Date.parse("2022-10-27T23:59:59.953Z");
  const twitter = createTestQuote({ symbol: "TWTR", price: 53.86, lastUpdated: lastTrade, lastTradeTime: lastTrade, stale: true });
  const behind = createTestQuote({ symbol: "AAPL", lastUpdated: Date.now() - 10 * 24 * 60 * 60_000, stale: true });
  const source = venueSource("TWTR", [], { TWTR: twitter, AAPL: behind });
  const saved = createTestTicker("TWTR", "Twitter, Inc.", { exchange: "NYSE" });
  const cli = createTestCliContext({
    dataProvider: source.dataProvider,
    store: { loadTicker: async (symbol: string) => symbol === "TWTR" ? saved : null, loadAllTickers: async () => [saved] },
  });
  await quoteCommand.execute(["TWTR", "AAPL"], cli.context);
  const printed = cli.printed[0]!;
  expect(printed.result.warnings).toEqual(["TWTR (Twitter, Inc.): no longer trading since 2022-10-27 (last price $53.86)"]);
  const rows = printed.options!.rows!(printed.result.data) as Array<{ symbol: string; name: string; price: string }>;
  expect(rows[0]).toMatchObject({ symbol: "TWTR", name: "Twitter, Inc.", price: "$53.86" });
});

test("a bare symbol several companies list names, in one line, the company it was read as and where the others are", async () => {
  const avis = createTestQuote({ symbol: "CAR", name: "Avis Budget Group, Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
  const names = { XETRA: "Carrefour SA", NASDAQ: "Avis Budget Group Inc.", BYMA: "Avis Budget Group, Inc. CEDEAR", ASX: "CAR Group Limited" };
  const source = venueSource("CAR", ["XETRA", "NASDAQ", "BYMA", "ASX"], { CAR: avis, "CAR:ASX": avis }, names);

  const bare = await runQuote(["CAR"], source);
  expect(bare.rows.map((row) => row.target.symbol)).toEqual(["CAR"]);
  expect(bare.warnings).toEqual(["CAR = Avis Budget Group, NASDAQ (also XETRA, ASX)"]);
  // A named venue is the user's choice: nothing to say, and no search.
  const searched = source.searches();
  expect((await runQuote(["CAR:ASX"], source)).warnings).toEqual([]);
  expect(source.searches()).toBe(searched);
});

test("a symbol whose company moved says so in one line and in its JSON row; the symbol it moved to, one with no change or no service print nothing", async () => {
  const etf = createTestQuote({ symbol: "FB", name: "ProShares S&P 500 Dynamic Daily Buffer ETF", listingExchangeName: "BATS", exchangeName: "BATS" });
  const meta = createTestQuote({ symbol: "META", name: "Meta Platforms, Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
  const apple = createTestQuote({ symbol: "AAPL", name: "Apple Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
  const hop = { from: "FB", to: "META", date: "2022-06-09" };
  const changes: Record<string, TickerChanges> = {
    FB: { symbol: "FB", moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [hop] }, formerly: null, listedName: null, changes: [hop] },
    META: { symbol: "META", moved: null, formerly: [hop], listedName: "Meta Platforms, Inc.", changes: [hop] },
  };
  const quote = async (args: string[], getTickerChanges: DataProvider["getTickerChanges"]) => {
    const source = venueSource("FB", [], { FB: etf, META: meta, AAPL: apple });
    return runQuote(args, { ...source, dataProvider: { ...source.dataProvider, getTickerChanges } });
  };

  const moved = await quote(["FB", "META", "AAPL"], async (symbol) => changes[symbol] ?? null);
  expect(moved.warnings).toEqual(["FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)"]);
  // META is what was typed: its change stays in the row as data, with no line.
  expect(moved.rows.map((row) => (row as { tickerChange?: { kind: string } }).tickerChange?.kind ?? null)).toEqual(["moved", "formerly", null]);
  // Offline: the quote still answers, with nothing extra.
  const offline = await quote(["FB"], async () => { throw new Error("fetch failed"); });
  expect(offline.failure).toBeNull();
  expect(offline.warnings).toEqual([]);
  expect(offline.rows[0]).not.toHaveProperty("tickerChange");
});

test("a symbol whose company merged into another names it in one line and its JSON row; the old name searches as the company it merged into", async () => {
  // Golden Ocean merged into CMB.Tech (CMBT) in 2025 and Eagle Bulk into Star Bulk (SBLK) in 2024; funds list there now.
  const formerIssuer = (symbol: string, name: string, until: string, successor: { symbol: string; name: string }) => ({
    symbol, moved: null, formerly: null, listedName: null, changes: [], formerIssuer: { symbol, name, until, successor, source: `https://www.sec.gov/${symbol}` },
  });
  const changes: Record<string, TickerChanges> = {
    GOGL: formerIssuer("GOGL", "Golden Ocean Group Ltd", "2025-08-20", { symbol: "CMBT", name: "Cmb.Tech NV" }),
    EGLE: formerIssuer("EGLE", "Eagle Bulk Shipping Inc.", "2024-04-09", { symbol: "SBLK", name: "Star Bulk Carriers Corp." }),
  };
  const fund = (symbol: string, name: string) => createTestQuote({ symbol, name, listingExchangeName: "BATS", exchangeName: "BATS" });
  const source = venueSource("GOGL", [], { GOGL: fund("GOGL", "Corgi GOOGL 2x Daily ETF"), EGLE: fund("EGLE", "Global X S&P 500 U.S. Revenue Leaders ETF") });
  const quoted = await runQuote(["GOGL", "EGLE"], { ...source, dataProvider: { ...source.dataProvider, getTickerChanges: async (symbol) => changes[symbol] ?? null } });
  expect(quoted.warnings).toEqual([
    "GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT",
    "EGLE was Eagle Bulk Shipping until 2024, now Star Bulk Carriers: SBLK",
  ]);
  expect((quoted.rows[0] as { formerIssuer?: unknown }).formerIssuer).toEqual({
    ...changes.GOGL!.formerIssuer, note: "GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT",
  });

  // Search sends the company it merged into for the old name, naming it; the line is quote's. It is the
  // primary listing though the old company's leftover line matches the name better, and that line,
  // linked by its name, says what it became; a namesake search cannot link stays below.
  const former = { symbol: "GOGL", name: "Golden Ocean Group Ltd", until: "2025-08-20", successor: { symbol: "CMBT", name: "Cmb.Tech NV" } };
  const dataProvider = createTestDataProvider({
    search: async () => [
      { providerId: "test", symbol: "GOGLC", name: "GOLDEN OCEAN GROUP", exchange: "BYMA", type: "Common Stock", currency: "ARS" },
      { providerId: "test", symbol: "GOMH", name: "Golden Ocean Mining Holdings", exchange: "TSXV", type: "Common Stock", currency: "CAD" },
      {
        providerId: "test", symbol: "CMBT", name: "Cmb.Tech NV", exchange: "NYSE", type: "Common Stock", currency: "USD",
        searchAliases: ["Golden Ocean Group Ltd"], formerIssuer: former,
      },
    ],
  });
  const printed: PrintedCliResult["result"][] = [];
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  await search("Golden Ocean", { initMarketData, printResult: (result) => { printed.push(result); } });
  expect(printed[0]!.warnings).toEqual(["GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT"]);
  expect((printed[0]!.data as Array<Record<string, unknown>>).map(({ category, symbol, formerIssuer }) => ({ category, symbol, formerIssuer }))).toEqual([
    { category: "Primary Listing", symbol: "CMBT", formerIssuer: former },
    { category: "Other Listings", symbol: "GOGLC", formerIssuer: former },
    { category: "Other Listings", symbol: "GOMH", formerIssuer: undefined },
  ]);
});

test("search lists a symbol it no longer finds as no longer trading with its last date, and says when a company left a symbol it finds", async () => {
  const lastTrade = Date.parse("2022-10-27T23:59:59.953Z");
  const twitter = createTestQuote({ symbol: "TWTR", price: 53.86, lastUpdated: lastTrade, lastTradeTime: lastTrade, stale: true });
  const fund = "ProShares S&P 500 Dynamic Daily Buffer ETF";
  const etf = createTestQuote({ symbol: "FB", name: fund, listingExchangeName: "BATS", exchangeName: "BATS" });
  const hop = { from: "FB", to: "META", date: "2022-06-09" };
  const dataProvider = createTestDataProvider({
    search: async (query) => query.toUpperCase() === "FB" ? [{ providerId: "test", symbol: "FB", name: fund, exchange: "BATS", type: "ETF", currency: "USD" }] : [],
    getQuote: async (symbol) => {
      if (symbol === "TWTR") return twitter;
      if (symbol === "FB") return etf;
      throw new Error(`Not a ticker: ${symbol}.`);
    },
    getTickerChanges: async (symbol) => symbol === "FB"
      ? { symbol, moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [hop] }, formerly: null, listedName: null, changes: [hop] }
      : null,
  });
  const initMarketData = async () => ({ store: { loadAllTickers: async () => [] }, dataProvider, persistence: { close() {} } }) as never;
  const json = async (query: string) => {
    const printed: PrintedCliResult["result"][] = [];
    await search(query, { initMarketData, printResult: (result) => { printed.push(result); } });
    return printed[0]!;
  };

  const twtr = await json("twtr");
  expect(twtr.data).toEqual([expect.objectContaining({
    category: "No Longer Trading", symbol: "TWTR", lastTraded: "2022-10-27", lastPrice: "$53.86",
    note: "TWTR stopped trading 2022-10-27; no history or options served",
  })]);
  // It was found: no pointer to the catalog.
  expect(twtr.warnings).toBeUndefined();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await search("TWTR", { initMarketData });
    const text = String(log.mock.calls[0]![0]).replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("No Longer Trading");
    expect(text).toMatch(/TWTR\s+2022-10-27\s+\$53\.86/);
    expect(text).not.toContain("No matches found.");
  } finally {
    log.mockRestore();
  }

  const fb = await json("FB");
  expect(fb.warnings).toEqual([`FB now lists ${fund}; Meta Platforms trades as META (changed 2022-06-09)`]);
  expect((fb.data as Array<{ category: string }>).map((row) => row.category)).not.toContain("No Longer Trading");
  // A symbol with no change and no quote says nothing more.
  expect((await json("ZZZZ")).warnings).toEqual(['Search finds tickers and company names. Try: gloom catalog "ZZZZ"']);
});

test("a pasted list is one row per symbol, in order, however it is separated, for quote and compare alike", async () => {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
    },
  });
  const pasted = [["jnk\nEMB\nBRK.B, bf-b "], ["JNK EMB", "brk.b,BF-B"], ["jnk\temb\r\nbrk.b bf-b"], ["jnk,emb", "$brk.b\n", " bf-b "]];
  for (const name of ["quote", "compare"]) {
    for (const args of pasted) {
      asked.length = 0;
      const cli = createTestCliContext({ dataProvider });
      await marketDataCliCommands.find((command) => command.name === name)!.execute(args, cli.context);
      const rows = (cli.printed[0] as PrintedCliResult).result.data as Array<{ target: QuoteSubscriptionTarget }>;
      expect(rows.map((row) => row.target.symbol)).toEqual(["JNK", "EMB", "BRK.B", "BF-B"]);
      expect(asked).toEqual([["JNK", "EMB", "BRK.B", "BF-B"]]);
    }
  }
});

test("a company's name in a pasted list is quoted as its listing, never as its words", async () => {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => /whirlpool/i.test(query)
      ? [{ providerId: "test", symbol: "WHR", name: "Whirlpool Corp", exchange: "NYSE", type: "Common Stock", currency: "USD" }]
      : [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
    },
  });
  const cli = createTestCliContext({ dataProvider });
  await quoteCommand.execute(["WHR, Whirlpool Corporation, BRK.B"], cli.context);
  expect(asked).toEqual([["WHR", "WHR:NYSE", "BRK.B"]]);
  expect((cli.printed[0] as PrintedCliResult).result.warnings).toContain('Read "Whirlpool Corporation" as WHR:NYSE (Whirlpool Corp).');
});

test("a company's name typed as one word no listing trades as is quoted as its listing, said in the user's spelling; a ticker wins", async () => {
  const listed = (symbol: string, name: string, exchange: string) => ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "USD" });
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => /^apple$/i.test(query) ? [listed("AAPL", "Apple Inc.", "NASDAQ"), listed("APC", "Apple Inc.", "XETRA")]
      : /^gold$/i.test(query) ? [listed("GLDG", "Gold Corp", "NYSE")]
      : /^grp$/i.test(query) ? [listed("GCR", "Greencoat Group plc", "NYSE")]
      : [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ["APPLE", "GRP"].includes(target.symbol)
        ? { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) }
        : { target, quote: createTestQuote({ symbol: target.symbol }) });
    },
  });
  const cli = createTestCliContext({ dataProvider });
  await quoteCommand.execute(["Apple", "GOLD", "grp"], cli.context);
  const { result } = cli.printed[0] as PrintedCliResult;
  // GOLD trades, so it is GOLD, never the company search finds for the word; a short form (grp) names no company.
  expect((result.data as Array<{ target: QuoteSubscriptionTarget }>).map((row) => row.target.symbol)).toEqual(["AAPL:NASDAQ", "GOLD", "GRP"]);
  expect(asked).toEqual([["APPLE", "GOLD", "GRP"], ["AAPL:NASDAQ"]]);
  const read = result.warnings!.find((warning) => warning.startsWith("Read "))!;
  expect(read).toBe('Read "APPLE" as AAPL:NASDAQ (Apple Inc.).');
  expect(withSearchHints(read, ["Apple", "GOLD", "grp"])).toBe('Read "Apple" as AAPL:NASDAQ (Apple Inc.).');
  expect(result.warnings).toContain("Not a ticker: GRP.");
});

test("a word many names share is a name only as search's top result or an exact name; a coin's or a subject's name keeps its hint", async () => {
  const row = (symbol: string, name: string, exchange: string, type = "Common Stock") => ({ providerId: "test", symbol, name, exchange, type, currency: "USD" });
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      switch (query.toLowerCase()) {
        // Search puts a REIT first, but Apple Inc. is the name and nothing more.
        case "apple": return [row("APLE", "Apple Hospitality REIT, Inc.", "NYSE"), row("AAPL", "Apple Inc.", "NASDAQ")];
        // The top result is a future; the stocks only have the word in their names.
        case "oil": return [row("CL=F", "WTI Crude Oil", "NYM", "FUTURE"), row("OILX", "Onyx Spot Return Crude Oil", "ARCA"), row("OINL", "Oil India Limited", "NSE")];
        case "bitcoin": return [row("BCH-USD", "Bitcoin Cash", "CCC", "CRYPTOCURRENCY"), row("BSTY/BTC", " Bitcoin", "YOBIT", "Digital Currency"), row("BTCS", "Bitcoin Shop Inc.", "NASDAQ")];
        case "hyperliquid": return [row("PURR", "Hyperliquid Strategies Inc", "NASDAQ")];
        // A venue the app cannot read is no answer, never a failed command.
        case "zorblax": return [row("ZBX", "Zorblax", "MOONX")];
        default: return [row("CRBN", "Carbon Inc.", "NASDAQ")];
      }
    },
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => target.exchange
      ? { target, quote: createTestQuote({ symbol: target.symbol }) }
      : { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) }),
  });
  // The crypto board lists Hyperliquid, which no list of major coins names.
  resetBoardCoins([{ symbol: "BTC-USD", code: "BTC", name: "Bitcoin", marketCap: 2 }, { symbol: "HYPE-USD", code: "HYPE", name: "Hyperliquid", marketCap: 1 }]);
  const words = ["Apple", "oil", "bitcoin", "hyperliquid", "carbon", "zorblax"];
  const cli = createTestCliContext({ dataProvider });
  await quoteCommand.execute(words, cli.context);
  const { result } = cli.printed[0] as PrintedCliResult;
  expect((result.data as Array<{ target: QuoteSubscriptionTarget }>).map((row) => row.target.symbol)).toEqual(["AAPL:NASDAQ", "OIL", "BITCOIN", "HYPERLIQUID", "CARBON", "ZORBLAX"]);
  expect(result.warnings!.map((warning) => withSearchHints(warning, words))).toEqual([
    'Read "Apple" as AAPL:NASDAQ (Apple Inc.).',
    "Not a ticker: OIL. Try `gloom search oil`.",
    "Not a ticker: BITCOIN. Did you mean BTC-USD (Bitcoin)?",
    "Not a ticker: HYPERLIQUID. Did you mean HYPE-USD (Hyperliquid)?",
    "Not a ticker: CARBON. Try `gloom search carbon`.",
    "Not a ticker: ZORBLAX. Try `gloom search zorblax`.",
  ]);
});

test("a company's name read as an index asks about the company's stock; marked by the service, it is that stock", async () => {
  const row = (symbol: string, name: string, exchange: string, type: string, searchAliases?: string[]) =>
    ({ providerId: "test", symbol, name, exchange, type, currency: "USD", ...searchAliases ? { searchAliases } : {} });
  const index = row("^JTEK", "JP MORGAN ETF TRUS", "NASDAQ", "INDEX");
  const warningsFor = async (answers: Record<string, ReturnType<typeof row>[]>) => {
    const dataProvider = createTestDataProvider({
      search: async (query) => answers[query] ?? [],
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> =>
        targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) })),
    });
    const cli = createTestCliContext({ dataProvider });
    await quoteCommand.execute(["JP Morgan"], cli.context);
    return (cli.printed[0] as PrintedCliResult).result.warnings;
  };
  // An older service: the index for "JP Morgan", the company for "JPMorgan".
  expect(await warningsFor({ "JP Morgan": [index], JPMorgan: [row("JPM", "JPMorgan Chase & Co.", "NYSE", "EQUITY")] }))
    .toContain('Read "JP Morgan" as ^JTEK:NASDAQ (JP MORGAN ETF TRUS). Did you mean JPM (JPMorgan Chase & Co.)?');
  // The service marks the company the name means.
  expect(await warningsFor({ "JP Morgan": [row("JPM", "JPMorgan Chase & Co.", "NYSE", "Common Stock", ["JPMorgan", "JPMorgan Chase"]), index] }))
    .toContain('Read "JP Morgan" as JPM:NYSE (JPMorgan Chase & Co.).');
});

test("quote and compare exit 1 when none of the symbols has a quote, 0 when some do, and print the same table either way", async () => {
  const dataProvider = createTestDataProvider({
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => target.symbol === "AAPL"
      ? { target, quote: createTestQuote({ symbol: "AAPL" }) }
      : { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) }),
  });
  const run = async (name: string, ...symbols: string[]) => {
    const cli = createTestCliContext({ dataProvider });
    process.exitCode = 0;
    const { exitCode } = await captureConsole(() => marketDataCliCommands.find((command) => command.name === name)!.execute(symbols, cli.context));
    return { exitCode: exitCode ?? 0, rows: (cli.printed[0]!.result.data as Array<{ target: { symbol: string }; error?: string | null }>) };
  };
  for (const name of ["quote", "compare"]) {
    const none = await run(name, "GMEE", "ZZZZQ");
    expect(none.exitCode).toBe(1);
    expect(none.rows.map((row) => [row.target.symbol, row.error])).toEqual([["GMEE", "Not a ticker: GMEE."], ["ZZZZQ", "Not a ticker: ZZZZQ."]]);
    // One symbol that resolves is a result; the one that did not stays named in the table.
    const mixed = await run(name, "GMEE", "AAPL");
    expect(mixed.exitCode).toBe(0);
    expect(mixed.rows.map((row) => row.target.symbol)).toEqual(["GMEE", "AAPL"]);
    expect((await run(name, "AAPL")).exitCode).toBe(0);
  }
});

test("one symbol that names no listing, or nothing at all, never sinks the batch: the others are quoted and it gets one line", async () => {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
    },
  });
  const run = async (args: string[]) => {
    const cli = createTestCliContext({ dataProvider });
    process.exitCode = 0;
    asked.length = 0;
    const { exitCode } = await captureConsole(() => quoteCommand.execute(args, cli.context));
    const { result } = cli.printed[0]!;
    return { exitCode: exitCode ?? 0, symbols: (result.data as Array<{ target: QuoteSubscriptionTarget }>).map((row) => row.target.symbol), warnings: result.warnings ?? [] };
  };
  // `Unknown exchange US for EQT:NYSE.` failed the command, with no quote for EQT or UNG. Quotes for some of what
  // was asked are a result, as they are for `fn`: exit 0, the misses named in the warnings (and in --json).
  const venue = await run(["EQT", "EQT:NYSE:US", "UNG"]);
  expect(venue).toMatchObject({ exitCode: 0, symbols: ["EQT", "UNG"] });
  expect(venue.warnings).toEqual(["Not quoted: EQT:NYSE:US (Unknown exchange US for EQT:NYSE)."]);

  const junk = await run(["EQT", "$$$", "N/A", "UNG"]);
  expect(junk).toMatchObject({ exitCode: 0, symbols: ["EQT", "UNG"], warnings: ["Not symbols, not quoted: $$$, N/A."] });
  expect(asked).toEqual([["EQT", "UNG"]]);
});

test("a quoted phrase with a figure in it gets the phrase answer, never quotes for its words", async () => {
  const asked: string[] = [];
  const tickers = new Set(["YEAR", "YIELD", "FED", "FUNDS", "RATE"]);
  const dataProvider = createTestDataProvider({
    search: async () => [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(...targets.map((target) => target.symbol));
      return targets.map((target) => tickers.has(target.symbol)
        ? { target, quote: createTestQuote({ symbol: target.symbol }) }
        : { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) });
    },
  });
  const answer = async (phrase: string) => {
    const cli = createTestCliContext({ dataProvider }, { format: "json" });
    return quoteCommand.execute([phrase], cli.context).then(() => cli.printed, (error: Error) => error.message);
  };
  // A figure made the phrase a list, so YEAR and YIELD, or FED, FUNDS and RATE, were quoted.
  for (const phrase of ["10 year yield", "10.5 year yield", "fed funds rate 5.25%"]) {
    expect(await answer(phrase)).toBe(`"${phrase}" is not a ticker or a company's name.`);
  }
  // A number is never asked for as a ticker; a whole one (10) is a code and still is.
  expect(asked.filter((symbol) => /\d/.test(symbol))).toEqual(["10"]);
});

test("quote --file of a European sheet asks only for its symbols and names its prices in one line", async () => {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "gloomberb-quote-file-"));
  try {
    const file = join(dir, "energy.csv");
    await Bun.write(file, "ED 2.582,52\nCNX;1.899,21\nEQT\t3.594,10\n");
    const cli = createTestCliContext({ dataProvider });
    await quoteCommand.execute(["--file", file], cli.context);
    // Each price was a "Not a ticker" warning of its own, asked for as 2.582, 1.899 and 3.594.
    expect(asked).toEqual([["ED", "CNX", "EQT"]]);
    expect(cli.printed[0]!.result.warnings).toEqual(["Read the first column as symbols; ignored the 3 number cells beside it: 2.582,52; 1.899,21; 3.594,10."]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Bloomberg codes are each one listing: a file's lines, a quoted code, and a market code no venue answers to is refused, never split", async () => {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => query === "AAPL"
      ? [{ providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "Common Stock", currency: "USD" },
        { providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "SWX", type: "Common Stock", currency: "CHF" }]
      : [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "gloomberb-quote-bloomberg-"));
  try {
    const file = join(dir, "codes.txt");
    await Bun.write(file, "MC FP\nAIR FP\nALV GY\nTSCO LN\nCSL AU\nAAPL GP\n");
    const cli = createTestCliContext({ dataProvider });
    await quoteCommand.execute(["--file", file], cli.context);
    // Each line was two symbols: Moelis and FP, AAR, Autoliv, Tractor Supply and LN, Carlisle and AU, Apple and GP.
    expect(asked).toEqual([["MC:EPA", "AIR:EPA", "ALV:XETRA", "TSCO:LSE", "CSL:ASX"]]);
    expect(cli.printed[0]!.result.warnings).toContain("Not quoted: AAPL GP (GP is not a market code; did you mean AAPL US?).");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  asked.length = 0;
  const quoted = createTestCliContext({ dataProvider });
  await quoteCommand.execute(["VOD LN"], quoted.context);
  expect(asked).toEqual([["VOD:LSE"]]);
  expect(quoted.printed[0]!.result.warnings).toContain('Read "VOD LN" as VOD:LSE.');

  const refused = await runQuote(["AAPL GP"], { dataProvider, batches: [], searches: () => 0 });
  expect(refused.failure).toEqual({
    message: "GP is not a market code; did you mean AAPL US?",
    details: "AAPL also trades as AAPL SW.\nFor two symbols, separate them with a comma: AAPL, GP.",
  });
});

test("700.HK, 6758.JP and BRK/B are quoted in the form that works", async () => {
  const source = venueSource("X", [], {
    "0700.HK": createTestQuote({ symbol: "0700.HK" }),
    "6758.T": createTestQuote({ symbol: "6758.T" }),
    "BRK-B": createTestQuote({ symbol: "BRK-B" }),
  });
  for (const [typed, symbol] of [["700.HK", "0700.HK"], ["6758.JP", "6758.T"], ["BRK/B", "BRK-B"]]) {
    const { failure, rows } = await runQuote([typed!], source);
    expect(failure).toBeNull();
    expect(rows.map((row) => row.target.symbol)).toEqual([symbol!]);
  }
});

test("London's BP. is its London line where London lists it; a stray dot after a US ticker (GE.) is the ticker", async () => {
  // Search lists BP on NYSE and LSE, GE on NYSE only.
  const listing = (symbol: string, exchange: string) => ({ providerId: "test", symbol, name: `${symbol} plc`, exchange, type: "Common Stock", currency: "USD" });
  const asked: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query: string) => query.toUpperCase().startsWith("BP") ? [listing("BP", "NYSE"), listing("BP", "LSE")] : [listing("GE", "NYSE")],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => {
      asked.push(target.symbol);
      return { target, quote: createTestQuote({ symbol: target.symbol }) };
    }),
  });
  const source = { dataProvider, batches: [], searches: () => 0 };
  const london = await runQuote(["BP."], source);
  expect(london.rows.map((row) => row.target.symbol)).toEqual(["BP:LSE"]);
  expect(london.warnings).toContain("Read BP. as BP:LSE.");
  const us = await runQuote(["GE."], source);
  expect(us.failure).toBeNull();
  expect(us.rows.map((row) => row.target.symbol)).toEqual(["GE"]);
  expect(asked).not.toContain("GE:LSE");
});

test("a file's line that is a company's name before its legal form is the company, beside codes on the lines around it", async () => {
  const asked: string[][] = [];
  const company = (symbol: string, name: string, exchange: string) => ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "EUR" });
  const dataProvider = createTestDataProvider({
    search: async (query) => /^siemens/i.test(query) ? [company("SIE", "Siemens AG", "XETRA")]
      : /^sap/i.test(query) ? [company("SAP", "SAP SE", "XETRA")]
      : query === "BRK-B" ? [company("BRK.B", "Berkshire Hathaway Inc.", "NYSE")]
      : [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
      asked.push(targets.map((target) => target.symbol));
      return targets.map((target) => ({ target, quote: createTestQuote({ symbol: target.symbol }) }));
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "gloomberb-quote-legal-form-"));
  try {
    const file = join(dir, "names.txt");
    await Bun.write(file, "SIEMENS AG\nSAP SE\nVOD LN\nBRK/B US Equity\n");
    const cli = createTestCliContext({ dataProvider });
    await quoteCommand.execute(["--file", file], cli.context);
    expect(asked).toEqual([["SIE:XETRA", "SAP:XETRA", "VOD:LSE", "BRK-B"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
