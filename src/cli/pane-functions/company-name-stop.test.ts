import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { noProviderError } from "../../sources/provider-errors";
import { createDefaultConfig } from "../../types/config";
import { captureConsole } from "../../test-support/console";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createMovedSymbolsProvider, MOVED_SYMBOL_QUOTES } from "../../test-support/moved-symbols";
import type { DataProvider, QuoteBatchResult, QuoteSubscriptionTarget } from "../../types/data-provider";
import { resetBoardCoins } from "../board-coins";
import { marketDataCliCommands } from "../commands/market";
import * as paneShot from "../desktop-pane-shot";
import { printCliError } from "../errors";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { runPaneFunction, runPaneScreenshot } from ".";

const config = createDefaultConfig("/tmp/gloom-company-name-stop-fixture");
const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

beforeEach(() => resetBoardCoins([]));
afterEach(() => {
  process.exitCode = 0;
  resetBoardCoins();
});

const row = (symbol: string, name: string) => ({ providerId: "test", symbol, name, exchange: "NASDAQ", type: "Common Stock", currency: "USD" });
const PALANTIR = createTestQuote({ symbol: "PLTR", name: "Palantir Technologies Inc.", price: 198.84, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
/** Search lists Palantir under its name and META under its symbol, as the service does. */
const search = async (query: string) => /palantir/i.test(query) ? [row("PLTR", "Palantir Technologies Inc.")] : /^meta$/i.test(query) ? [row("META", "Meta Platforms, Inc.")] : [];

/** The router's answer when a source failed rather than missed: it says nothing of whether the symbol exists. */
const timedOut = (symbol: string) => noProviderError(`No quote provider available for ${symbol}`, { failure: new Error("timed out") }, symbol);

/** Every source answers "not found" for a name; PLTR quotes. */
function notFoundSource(overrides: Partial<DataProvider> = {}): DataProvider {
  const quoteOf = (symbol: string) => {
    if (symbol.split(":")[0] === "PLTR") return PALANTIR;
    if (MOVED_SYMBOL_QUOTES[symbol]) return MOVED_SYMBOL_QUOTES[symbol]!;
    throw new Error(`Not a ticker: ${symbol}.`);
  };
  return createMovedSymbolsProvider(undefined, {
    search,
    getQuote: async (symbol) => quoteOf(symbol),
    getQuotesBatch: async (targets) => targets.map((target) => {
      try { return { target, quote: quoteOf(target.symbol) }; } catch (error) { return { target, quote: null, error }; }
    }),
    ...overrides,
  });
}

/** One source times out for everything but PLTR's own quote, so no name or ticker gets an answer. */
function timedOutSource(overrides: Partial<DataProvider> = {}): DataProvider {
  const quoteOf = (symbol: string) => {
    if (symbol.split(":")[0] === "PLTR") return PALANTIR;
    throw timedOut(symbol);
  };
  return notFoundSource({
    getQuote: async (symbol) => quoteOf(symbol),
    getQuotesBatch: async (targets): Promise<QuoteBatchResult[]> => targets.map((target) => {
      try { return { target, quote: quoteOf(target.symbol) }; } catch (error) { return { target, quote: null, error }; }
    }),
    getTickerFinancials: async (symbol) => { throw timedOut(symbol); },
    getPriceHistoryWithMetadata: async (symbol) => { throw timedOut(symbol); },
    ...overrides,
  });
}

async function run(args: string[], dataProvider: DataProvider, command = runPaneFunction) {
  const persistence = new AppPersistence(":memory:");
  const cli = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  try {
    const { result: error } = await captureConsole(() => command(args, cli.context).then(() => null, (failure: unknown) => failure));
    return { error: error as Error | null, printed: cli.printed[0] as PrintedCliResult | undefined };
  } finally {
    persistence.close();
  }
}

/** What the command line prints for the failure, hints included. */
async function stderrOf(error: unknown, command: "fn" | "shot", args: string[]) {
  return (await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, color: false }, { command, args }))).stderr;
}

test("fn reads a company's name, in words or one word, as the listing search finds, as quote does; one search finds no company for stops before any report", async () => {
  let financials = 0;
  const provider = notFoundSource({ getTickerFinancials: async () => { financials += 1; throw new Error("not read"); } });
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot").mockImplementation(async () => { throw new Error("Capture renderer reached"); });
  try {
    for (const code of ["RDCF", "PEB"]) {
      const { error, printed } = await run([code, "Palantir Technologies"], provider);
      expect(error).toBeNull();
      expect(printed!.result.data).toMatchObject({ symbols: ["PLTR:NASDAQ"] });
      expect(printed!.result.warnings).toEqual(["Read \"Palantir Technologies\" as PLTR:NASDAQ (Palantir Technologies Inc.)."]);
    }
    // A source that timed out on the word says nothing of it, and search still names the company, as `quote` reads it.
    const word = await run(["RDCF", "Palantir"], timedOutSource());
    expect(word.printed!.result.data).toMatchObject({ symbols: ["PLTR:NASDAQ"] });
    expect(word.printed!.result.warnings).toEqual(["Read \"Palantir\" as PLTR:NASDAQ (Palantir Technologies Inc.)."]);
    // --exchange names a venue for a ticker, which a name is not.
    const venue = await run(["RDCF", "Palantir Technologies", "--exchange", "NASDAQ"], provider);
    expect(venue.error!.message).toBe("Not a ticker: PALANTIR TECHNOLOGIES. Did you mean PLTR (Palantir Technologies Inc.)?");
    // No company by that name: the sentence ends at the words, and the printer adds the search to try.
    financials = 0;
    const unknown = await run(["RDCF", "Foo Bar Baz"], provider);
    expect(unknown.error!.message).toBe("Not a ticker: FOO BAR BAZ.");
    expect(await stderrOf(unknown.error, "fn", ["RDCF", "Foo Bar Baz"])).toBe("error: Not a ticker: FOO BAR BAZ. Try `gloom search \"Foo Bar Baz\"`.");
    expect(financials).toBe(0);
    expect(render).not.toHaveBeenCalled();
    // A terminal's code for a listing has spaces too, and is a listing.
    expect((await run(["RDCF", "META US Equity"], provider)).printed).toBeDefined();
    // META is a ticker whose source timed out: search lists it under that symbol, so it is no company's name.
    const meta = await run(["RDCF", "META"], timedOutSource());
    expect(meta.error).toBeNull();
    expect(meta.printed!.result.data).toMatchObject({ symbols: ["META"], empty: false });
    expect(((await run(["RDCF", "META"], timedOutSource(), runPaneScreenshot)).error)?.message).toBe("No quote provider available for META");
    // A word search finds no company for keeps the report it had.
    expect((await run(["RDCF", "Foobarbaz"], timedOutSource())).error).toBeNull();
  } finally {
    render.mockRestore();
  }
});

async function runQuote(word: string, dataProvider: DataProvider) {
  const cli = createTestCliContext({ config, dataProvider });
  await quoteCommand.execute([word], cli.context).catch(() => {});
  const [printed] = cli.printed as [PrintedCliResult];
  return { rows: printed.result.data as Array<{ target: QuoteSubscriptionTarget; quote: unknown; error?: unknown }>, warnings: printed.result.warnings ?? [] };
}

test("quote reads a one-word name a source timed out on as its company, or says it is not a ticker and names it", async () => {
  const read = await runQuote("palantir", timedOutSource());
  expect(read.rows[0]).toMatchObject({ target: { symbol: "PLTR:NASDAQ" }, quote: { price: 198.84 } });
  expect(read.warnings).toEqual(['Read "PALANTIR" as PLTR:NASDAQ (Palantir Technologies Inc.).']);
  // The company's own quote times out as well: the row says what the word is, not that no source is available.
  const unquoted = await runQuote("palantir", timedOutSource({
    getQuote: async (symbol) => { throw timedOut(symbol); },
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: null, error: timedOut(target.symbol) })),
  }));
  expect(unquoted.rows[0]!.quote).toBeNull();
  expect(String(unquoted.rows[0]!.error)).toContain("Not a ticker: PALANTIR. Did you mean PLTR (Palantir Technologies Inc.)?");
  // A real ticker a source timed out on stays unavailable, as before.
  const real = await runQuote("META", timedOutSource({ getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: null, error: timedOut(target.symbol) })) }));
  expect(real.rows[0]!.quote).toBeNull();
  expect(String(real.rows[0]!.error)).toContain("No quote provider available for META");
  expect(real.warnings.join()).not.toContain("Not a ticker");
});

// Each lowercase symbol of a list cost a quote to check whether it was a company's name, however long the list.
test("a long list is tickers: its lowercase symbols cost no quote each to be read as names; a short one still reads them", async () => {
  const quotes = async (arg: string) => {
    let asked = 0;
    const dataProvider = createTestDataProvider({
      getQuote: async (symbol) => {
        asked += 1;
        return createTestQuote({ symbol, currency: "USD" });
      },
    });
    expect((await run(["RV", arg], dataProvider)).error).toBeNull();
    return asked;
  };
  const many = Array.from({ length: 11 }, (_, index) => `t${String.fromCharCode(97 + index)}x`);
  expect(await quotes(many.join(","))).toBe(0);
  expect(await quotes("aapl,msft")).toBe(2);
});
