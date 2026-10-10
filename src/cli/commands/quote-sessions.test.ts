import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { HeadlessPaneContext } from "../../types/headless";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { renderHeadlessPaneText } from "../pane-functions/headless";
import { quoteComparisonHeadless } from "../../plugins/builtin/ticker-detail/headless";
import { marketDataCliCommands } from "./market";

const config = createDefaultConfig("/tmp/gloom-quote-sessions-test");

// AAPL on Saturday 2026-10-10: the quote's price and change are Friday's last
// after-hours print against Thursday's close; the regular close rides beside it.
const afterHours: Quote = {
  symbol: "AAPL", currency: "USD", price: 336.08, change: -4.34, changePercent: -1.2749,
  previousClose: 340.42, regularClose: 336.64, regularCloseSessionDate: "2026-10-09",
  regularChange: -3.78, regularChangePercent: -1.1104, changeSessionDate: "2026-10-09",
  marketState: "CLOSED", listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-09T23:59:31Z"),
};
// MSFT before Friday's open: a pre-market print, with Thursday's close and its move.
const preMarket: Quote = {
  symbol: "MSFT", currency: "USD", price: 528, change: 5.39, changePercent: 1.0314,
  previousClose: 522.61, regularClose: 522.61, regularCloseSessionDate: "2026-10-08",
  regularChange: 3.2, regularChangePercent: 0.6161, changeSessionDate: "2026-10-09",
  marketState: "PRE", preMarketPrice: 528, preMarketChange: 5.39, preMarketChangePercent: 1.0314,
  listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-09T12:00:00Z"),
};
// A venue with no extended trading.
const closed: Quote = {
  symbol: "7203.T", currency: "JPY", price: 2910.5, change: 8.5, changePercent: 0.2929,
  previousClose: 2902, marketState: "CLOSED", listingExchangeName: "JPX", lastUpdated: Date.parse("2026-10-09T06:30:00Z"),
};

async function compare(quotes: Quote[]) {
  const cli = createTestCliContext({ config, dataProvider: {
    getQuotesBatch: async () => quotes.map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
  } });
  await marketDataCliCommands.find((command) => command.name === "compare")!.execute(quotes.map((quote) => quote.symbol), cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options);
  return { data: result.data as Array<Record<string, unknown>>, rows: options!.rows!(result.data) as Array<Record<string, unknown>>, text };
}

test("quote, compare and QQ headline the regular session and give the extended print its own column", async () => {
  const { data, rows, text } = await compare([afterHours, preMarket, closed]);
  // Last, Chg% and Prev Close are the regular session `ticker` reports, not the extended print.
  expect(rows.map(({ rawPrice, changePercent, previousClose }) => ({ rawPrice, changePercent, previousClose }))).toEqual([
    { rawPrice: 336.64, changePercent: -1.11, previousClose: "$340.42" },
    { rawPrice: 522.61, changePercent: 0.62, previousClose: "$519.41" },
    { rawPrice: 2910.5, changePercent: 0.29, previousClose: "¥2,902" },
  ]);
  expect(rows.map(({ extendedSession, rawExtendedPrice, extendedChangePercent }) => ({ extendedSession, rawExtendedPrice, extendedChangePercent }))).toEqual([
    { extendedSession: "POST", rawExtendedPrice: 336.08, extendedChangePercent: -0.17 },
    { extendedSession: "PRE", rawExtendedPrice: 528, extendedChangePercent: 1.03 },
    { extendedSession: null, rawExtendedPrice: null, extendedChangePercent: null },
  ]);
  expect(text).toMatch(/Pre-Market +After Hours/);
  expect(text).toContain("$336.08 -0.17%");
  // JSON keeps the quote as sent and puts the table's figures beside it.
  expect(data[0]).toMatchObject({ price: 336.64, change: -3.78, extendedSession: "POST", extendedPrice: 336.08, quote: { price: 336.08 } });

  // Without an extended print the table is as narrow as before.
  expect((await compare([closed])).text).not.toMatch(/Pre-Market|After Hours/);

  const quotes = new Map([afterHours, preMarket, closed].map((quote) => [quote.symbol, quote]));
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({ getQuote: async (symbol) => quotes.get(symbol)! }) } as HeadlessPaneContext;
  const args = (symbols: string[]) => ({ symbols, argument: symbols, rawArgument: symbols.join(","), options: {} });
  const board = await quoteComparisonHeadless.load(args(["AAPL", "MSFT"]), ctx);
  expect(board.rows.map(({ price, change, extendedSession, extendedPrice }) => ({ price, change, extendedSession, extendedPrice }))).toEqual([
    { price: 336.64, change: -3.78, extendedSession: "POST", extendedPrice: 336.08 },
    { price: 522.61, change: 3.2, extendedSession: "PRE", extendedPrice: 528 },
  ]);
  expect(renderHeadlessPaneText(quoteComparisonHeadless, board, args(["AAPL", "MSFT"]), "Quote Monitor")).toMatch(/AAPL .*\$336\.64 .*-1\.11% .*— +\$336\.08 -0\.17%/);
  expect("columns" in await quoteComparisonHeadless.load(args(["7203.T"]), ctx)).toBe(false);
});

test("quote marks each stale row in its Feed cell, as many as the closing line counts", async () => {
  const cli = createTestCliContext({ config, dataProvider: {
    getQuotesBatch: async () => [
      { ...closed, stale: true, dataSource: "delayed" as const },
      { ...afterHours, symbol: "LIT", dataSource: "delayed" as const, lastUpdated: Date.now() - 60_000 },
    ].map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
  } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["7203.T", "LIT"], cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options);
  const lines = text.split("\n");
  expect(lines.find((line) => line.startsWith("7203.T"))).toMatch(/\bstale\b/);
  // Whatever the clock makes of the other row, the cells and the count agree.
  const marked = lines.filter((line) => /^\S+ .*\bstale\b/.test(line) && !line.startsWith("Source:")).length;
  const counted = Number(/(\d+) of 2 stale/.exec(text)?.[1] ?? (/\bstale\b/.test(lines.at(-1) ?? "") ? 2 : 0));
  expect(marked).toBe(counted);
  // JSON keeps the quote as sent.
  expect((result.data as Array<{ quote: Quote }>)[0]!.quote.dataSource).toBe("delayed");
});
