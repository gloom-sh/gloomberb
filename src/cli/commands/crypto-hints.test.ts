import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { CliCommandContext } from "../../types/plugin";
import { createTestCliContext } from "../../test-support/cli-context";
import { coinElsewhereNote, quoteNotes } from "./crypto-hints";
import { marketDataCliCommands } from "./market";
import { serializeCliResult } from "../result";
import { setCliColorEnabledOverride } from "../../utils/cli-output";
import { resetBoardCoins } from "../board-coins";

beforeEach(() => resetBoardCoins([]));
// A quote that finds nothing sets the exit status; it must not become the test run's.
afterEach(() => { process.exitCode = 0; resetBoardCoins(); });

const config = createDefaultConfig("/tmp/gloom-crypto-hints-test");
const HINT = "Crypto prices may be briefly unavailable; the CRYP function (gloom fn CRYP) shows the crypto board.";

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

test("a bare coin ticker read as another listing says where the coin is, firmly when that listing cannot be it", async () => {
  const etf = quote("BTC", "Grayscale Bitcoin Mini Trust ETF", "ETF");
  expect((await runQuote(["BTC"], { BTC: etf })).warnings)
    .toEqual(["BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD."]);
  expect((await runQuote(["ETH"], { ETH: quote("ETH", "Grayscale Ethereum Mini Trust ETF", "ETF") })).warnings)
    .toEqual(["ETH is Grayscale Ethereum Mini Trust ETF, not ethereum. For ethereum use ETH-USD."]);
  // A company whose name says nothing of the coin, but whose line is stale or delisted, is not what was meant either.
  const staleSol = { ...quote("SOL", "Emeren Group Ltd", "Common Stock"), stale: true };
  expect((await runQuote(["SOL"], { SOL: staleSol })).warnings).toEqual(["SOL is Emeren Group Ltd, not solana. For solana use SOL-USD."]);
  const delisted = { ...quote("LINK", "Interlink Electronics, Inc.", "EQUITY"), delisting: { status: "delisted" as const, lastTradeDate: "2025-12-12", historyStart: "2016-01-04" } };
  expect((await runQuote(["LINK"], { LINK: delisted })).warnings).toContain("LINK is Interlink Electronics, Inc., not chainlink. For chainlink use LINK-USD.");

  // A live company that only shares the letters may be the one meant: it says the coin exists, and no more.
  const quiet = (symbol: string, result: Quote, cliOptions = {}) => runQuote([symbol], { [symbol]: result }, cliOptions);
  expect((await quiet("LINK", quote("LINK", "Interlink Electronics, Inc.", "EQUITY"))).warnings)
    .toEqual(["LINK is Interlink Electronics, Inc. Also a coin: LINK-USD."]);
  expect((await quiet("ATOM", quote("ATOM", "Atomera Incorporated", "EQUITY"))).warnings)
    .toEqual(["ATOM is Atomera Incorporated. Also a coin: ATOM-USD."]);

  // The real coin and a symbol that is no top coin's get no note, and an explicit listing (--exchange) was asked for on purpose.
  expect((await quiet("BTC", quote("BTC", "Bitcoin USD", "CRYPTOCURRENCY"))).warnings).toBeUndefined();
  expect((await quiet("AAPL", quote("AAPL", "Apple Inc.", "EQUITY"))).warnings).toBeUndefined();
  expect((await quiet("CAR", quote("CAR", "Avis Budget Group", "EQUITY"))).warnings).toBeUndefined();
  const named = createTestCliContext({ config, dataProvider: { getQuotesBatch: async () => [{ target: { symbol: "BTC", exchange: "NYSE" }, quote: etf }] } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["BTC", "--exchange", "NYSE"], named.context);
  expect(named.printed[0]!.result.warnings).toBeUndefined();
  // The line is a warning in JSON too, beside the rows it explains.
  expect((await quiet("BTC", etf, { format: "json" })).warnings)
    .toEqual(["BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD."]);
});

test("a bare coin ticker several companies list, none of them the coin, points at the pair", () => {
  const solvay = [{ key: "SOL:FWB2", name: "Solvay SA" }, { key: "SOL:XDUS", name: "SOLVAY S.A." }];
  expect(coinElsewhereNote("SOL", solvay)).toBe("SOL is Solvay SA, not solana. For solana use SOL-USD.");
  const soul = { key: "SOL:ASX", name: "Washington H. Soul Pattinson and Company Limited" };
  expect(coinElsewhereNote("SOL", [...solvay, soul])).toBe("SOL is Solvay SA or Washington H. Soul Pattinson and Company Limited, not solana. For solana use SOL-USD.");
  expect(coinElsewhereNote("SOL", [...solvay, soul, { key: "SOL:NYSE", name: "Emeren Group" }])).toContain("Solvay SA, Washington H. Soul Pattinson and Company Limited or another company, not solana.");
  // A choice that already offers the pair, or a symbol that is not a major coin, needs no pointer.
  expect(coinElsewhereNote("SOL", [...solvay, { key: "SOL-USD", name: "Solana USD" }])).toBeNull();
  expect(coinElsewhereNote("CAR", [{ key: "CAR:NASDAQ", name: "Avis Budget Group" }, { key: "CAR:ASX", name: "CAR Group" }])).toBeNull();
});

test("a symbol no listing carries reads as not a ticker in the table and the notes, an outage as unavailable", async () => {
  const cli = createTestCliContext({ config, dataProvider: {
    // Search names no company Apple, so the word stays not a ticker.
    search: async () => [],
    getQuotesBatch: async (targets: Array<{ symbol: string; exchange: string }>) => targets.map((target) => ({
      target,
      quote: null,
      error: new Error(target.symbol === "APPLE" ? "Not a ticker: APPLE." : `No quote provider available for ${target.symbol}`),
    })),
  } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["Apple", "TSLA"], cli.context);
  const { result, options } = cli.printed[0]!;
  expect(result.warnings).toEqual(["Not a ticker: APPLE.", "TSLA: No quote provider available"]);
  setCliColorEnabledOverride(false);
  try {
    const rows = serializeCliResult(result, cli.context.cliOptions, options).split("\n");
    expect(rows.find((row) => row.startsWith("APPLE"))).toContain("not a ticker");
    expect(rows.find((row) => row.startsWith("TSLA"))).toContain("unavailable");
  } finally {
    setCliColorEnabledOverride(null);
  }
  // JSON keeps the error as thrown, per row.
  const json = createTestCliContext({ config, dataProvider: { search: async () => [], getQuotesBatch: async (targets: Array<{ symbol: string; exchange: string }>) => targets.map((target) => ({ target, quote: null, error: new Error("Not a ticker: APPLE.") })) } }, { format: "json" });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["Apple"], json.context);
  expect(json.printed[0]!.result.warnings).toBeUndefined();
  expect((json.printed[0]!.result.data as Array<{ error: string }>)[0]!.error).toBe("Not a ticker: APPLE.");
});
