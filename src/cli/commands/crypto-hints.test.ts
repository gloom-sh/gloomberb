import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { CliCommandContext } from "../../types/plugin";
import { createTestCliContext } from "../../test-support/cli-context";
import { quoteNotes } from "./crypto-hints";
import { marketDataCliCommands } from "./market";

const config = createDefaultConfig("/tmp/gloom-crypto-hints-test");
const HINT = "Crypto prices may be briefly unavailable; the CRYP function (gloomberb fn CRYP) shows the crypto board.";

function quote(symbol: string, name: string, instrumentType?: string): Quote {
  return { symbol, name, price: 36.11, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1_789_200_000_000, instrumentType };
}

async function runQuote(
  args: string[],
  results: Record<string, Quote | string>,
  cliOptions: Parameters<typeof createTestCliContext>[1] = {},
) {
  const cli = createTestCliContext({ config, dataProvider: {
    // The router words a failure "<reason> for <symbol>".
    getQuotesBatch: async (targets: Array<{ symbol: string; exchange: string }>) => targets.map((target) => {
      const result = results[target.symbol];
      return typeof result === "string"
        ? { target, quote: null, error: new Error(`${result} for ${target.symbol}`) }
        : { target, quote: result ?? null };
    }),
  } }, cliOptions);
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(args, cli.context);
  return cli.printed[0]!.result;
}

test("a failed quote says why in text mode, and points crypto pairs at the crypto board", async () => {
  const none = "No quote provider available";
  const crypto = await runQuote(["BTC-USD", "ETH-USD", "SOL-USD"], { "BTC-USD": none, "ETH-USD": none, "SOL-USD": none });
  expect(crypto.warnings).toEqual([`BTC-USD, ETH-USD, SOL-USD: ${none}. ${HINT}`]);

  // One line per distinct reason; equities and non-crypto dashes get no crypto pointer.
  const mixed = await runQuote(["AAPL", "BRK-B", "ZZZZ"], { AAPL: none, "BRK-B": none, ZZZZ: "Rate limited" });
  expect(mixed.warnings).toEqual([`AAPL, BRK-B: ${none}`, "ZZZZ: Rate limited"]);

  // Structured output keeps its shape: the reason is already in each row's error.
  const json = await runQuote(["BTC-USD"], { "BTC-USD": none }, { format: "json" });
  expect(json.warnings).toBeUndefined();
  expect((json.data as Array<{ error: string }>)[0]!.error).toBe(`${none} for BTC-USD`);
});

test("a sentence the data service wrote keeps its own ending, before the crypto board pointer too", () => {
  const note = (symbol: string, error: string) => quoteNotes([{ target: { symbol }, quote: null, error }]);
  expect(note("XAU/USD", "Spot gold is not quoted; GC=F is the front-month future.")).toEqual(["XAU/USD: Spot gold is not quoted; GC=F is the front-month future."]);
  expect(note("BTC-USD", "Not listed on this feed.")).toEqual([`BTC-USD: Not listed on this feed. ${HINT}`]);
  expect(note("BTC-USD", "Not listed on this feed")).toEqual([`BTC-USD: Not listed on this feed. ${HINT}`]);
});

test("history keeps its error and adds the crypto board pointer only for crypto pairs in text mode", async () => {
  const history = async (symbol: string, format: "text" | "json" = "text") => {
    const cli = createTestCliContext({ config, store: { loadTicker: async () => null }, dataProvider: {
      getPriceHistory: async () => { throw new Error(`No history provider available for ${symbol}`); },
    } }, { format });
    const context = { ...cli.context, fail: (message: string, details?: string) => {
      throw Object.assign(new Error(message), { details });
    } } as unknown as CliCommandContext;
    return marketDataCliCommands.find((command) => command.name === "history")!
      .execute([symbol, "--range", "1D"], context).then(() => null, (error: Error & { details?: string }) => error);
  };

  const detailsOf = (error: unknown) => [(error as Error).message, (error as { details?: string }).details];
  expect(detailsOf(await history("BTC-USD"))).toEqual(["No history provider available for BTC-USD", HINT]);
  expect(detailsOf(await history("AAPL"))).toEqual(["No history provider available for AAPL", undefined]);
  expect(detailsOf(await history("BTC-USD", "json"))).toEqual(["No history provider available for BTC-USD", undefined]);
});

test("a bare coin ticker that resolves to a fund says it is not the coin", async () => {
  const etf = quote("BTC", "Grayscale Bitcoin Mini Trust ETF", "ETF");
  expect((await runQuote(["BTC"], { BTC: etf })).warnings)
    .toEqual(["BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD."]);
  expect((await runQuote(["ETH"], { ETH: quote("ETH", "Grayscale Ethereum Mini Trust ETF", "ETF") })).warnings)
    .toEqual(["ETH is Grayscale Ethereum Mini Trust ETF, not ethereum. For ethereum use ETH-USD."]);

  // The real coin, a company that only shares the letters, and an unrelated ticker get no note.
  const quiet = (symbol: string, result: Quote, cliOptions = {}) => runQuote([symbol], { [symbol]: result }, cliOptions);
  expect((await quiet("BTC", quote("BTC", "Bitcoin USD", "CRYPTOCURRENCY"))).warnings).toBeUndefined();
  expect((await quiet("LINK", quote("LINK", "Interlink Electronics, Inc.", "EQUITY"))).warnings).toBeUndefined();
  expect((await quiet("AAPL", quote("AAPL", "Apple Inc.", "EQUITY"))).warnings).toBeUndefined();
  // JSON output is unchanged, and an explicit listing (--exchange) was asked for on purpose.
  expect((await quiet("BTC", etf, { format: "json" })).warnings).toBeUndefined();
  const named = createTestCliContext({ config, dataProvider: { getQuotesBatch: async () => [{ target: { symbol: "BTC", exchange: "NYSE" }, quote: etf }] } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["BTC", "--exchange", "NYSE"], named.context);
  expect(named.printed[0]!.result.warnings).toBeUndefined();
});
