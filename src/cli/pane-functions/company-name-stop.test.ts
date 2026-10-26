import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { noProviderError } from "../../sources/provider-errors";
import { createDefaultConfig } from "../../types/config";
import { captureConsole } from "../../test-support/console";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestQuote } from "../../test-support/data-provider";
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

test("fn and shot stop on a company's name with spaces before any report is built, naming the company search finds", async () => {
  let financials = 0;
  const provider = notFoundSource({ getTickerFinancials: async () => { financials += 1; throw new Error("not read"); } });
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot").mockImplementation(async () => { throw new Error("Capture renderer reached"); });
  try {
    for (const [command, code] of [[runPaneFunction, "RDCF"], [runPaneFunction, "PEB"], [runPaneScreenshot, "RDCF"]] as const) {
      const { error, printed } = await run([code, "Palantir Technologies"], provider, command);
      expect(printed).toBeUndefined();
      expect(error!.message).toBe("Not a ticker: PALANTIR TECHNOLOGIES. Did you mean PLTR (Palantir Technologies Inc.)?");
    }
    // No company by that name: the sentence ends at the words, and the printer adds the search to try.
    const unknown = await run(["RDCF", "Foo Bar Baz"], provider);
    expect(unknown.error!.message).toBe("Not a ticker: FOO BAR BAZ.");
    expect(await stderrOf(unknown.error, "fn", ["RDCF", "Foo Bar Baz"])).toBe("error: Not a ticker: FOO BAR BAZ. Try `gloom search \"Foo Bar Baz\"`.");
    expect(financials).toBe(0);
    expect(render).not.toHaveBeenCalled();
    // A terminal's code for a listing has spaces too, and is a listing.
    expect((await run(["RDCF", "META US Equity"], provider)).printed).toBeDefined();
  } finally {
    render.mockRestore();
  }
});

test("a one-word name a source could not answer for is not a ticker either when search finds the company; a real ticker keeps its own answer", async () => {
  const provider = timedOutSource();
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot").mockImplementation(async () => { throw new Error("Capture renderer reached"); });
  try {
    // Every source answers "not found": the same sentence, with the company beside it.
    const missed = await run(["RDCF", "Palantir"], notFoundSource({ getTickerFinancials: async (symbol) => { throw new Error(`Not a ticker: ${symbol}.`); } }));
    expect(missed.error!.message).toBe("Not a ticker: PALANTIR. Did you mean PLTR (Palantir Technologies Inc.)?");
    // One times out: the report is empty and said nothing of the word, but search says what it is.
    for (const command of [runPaneFunction, runPaneScreenshot]) {
      const { error, printed } = await run(["RDCF", "Palantir"], provider, command);
      expect(printed).toBeUndefined();
      expect(error!.message).toBe("Not a ticker: PALANTIR. Did you mean PLTR (Palantir Technologies Inc.)?");
    }
    // META is a ticker whose source timed out: search lists it under that symbol, so it is no company's name.
    const meta = await run(["RDCF", "META"], provider);
    expect(meta.error).toBeNull();
    expect(meta.printed!.result.data).toMatchObject({ symbols: ["META"], empty: false });
    expect(((await run(["RDCF", "META"], provider, runPaneScreenshot)).error)?.message).toBe("No quote provider available for META");
    // A word search finds no company for keeps the report it had.
    expect((await run(["RDCF", "Foobarbaz"], provider)).error).toBeNull();
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
