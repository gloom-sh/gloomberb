import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { Quote } from "../../types/financials";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../market-data/market/status";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { moverSessionPayload, sessionQuotes } from "../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride, setCliWidthOverride } from "../../utils/cli-output";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { overviewCliCommands } from "./overview";

afterEach(() => {
  mock.restore();
  setCliColorEnabledOverride(null);
  setCliWidthOverride(null);
});

/** `sectors`, `indices` or `movers trending` against these quotes, as data and as text. */
async function run(command: string, args: string[], quotes: Quote[], width: number | null = null) {
  const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const cli = createTestCliContext({ dataProvider: {
    getQuotesBatch: async (targets: Array<{ symbol: string }>) => targets.map((target) => ({
      target: { symbol: target.symbol, exchange: "" }, quote: bySymbol.get(target.symbol) ?? null,
    })),
  } });
  await overviewCliCommands.find((entry) => entry.name === command)!.execute(args, cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  setCliColorEnabledOverride(false);
  setCliWidthOverride(width);
  const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options);
  return { rows: result.data as Array<Record<string, unknown>>, text, line: (symbol: string) => text.split("\n").find((row) => row.startsWith(symbol)) ?? "" };
}

const round = (value: number | undefined) => value == null ? null : Number(value.toFixed(2));

test("sectors headlines each fund's regular close and gives its extended print a column, as `ticker` does", async () => {
  const sectors = (state: keyof ReturnType<typeof sessionQuotes>) => ["XLK", "XLV", "XLF", "XLY", "XLC", "XLI", "XLP", "XLE", "XLU", "XLRE", "XLB"]
    .map((symbol) => sessionQuotes(symbol)[state]);

  for (const state of ["weekend", "afterHours", "preMarket"] as const) {
    const quote = sessionQuotes()[state];
    const { rows, text, line } = await run("sectors", [], sectors(state));
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    expect(rows[0]).toMatchObject({
      symbol: "XLK", price: headline.price, change: headline.change, changePercent: round(headline.changePercent),
      extendedSession: extended.session, extendedPrice: extended.price, extendedChangePercent: round(extended.changePercent),
    });
    expect(text).toContain(state === "preMarket" ? "Pre-Market" : "After Hours");
    expect(line("XLK")).toMatch(state === "preMarket" ? /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%$/ : /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%$/);
  }

  // In the regular session the table is the live quote, with no extended column.
  const open = await run("sectors", [], sectors("regular"));
  expect(open.rows[0]).toMatchObject({ price: 199.1, changePercent: 0.67, extendedSession: null, extendedPrice: null });
  expect(open.text).not.toMatch(/After Hours|Pre-Market/);

  // A narrow terminal cuts the long fund names, never the figures.
  const narrow = await run("sectors", [], sectors("weekend"), 70);
  expect(narrow.line("XLK")).toMatch(/\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%$/);
  expect(narrow.text.split("\n").every((row) => row.length <= 70)).toBe(true);
});

test("indices and trending report an index level and a held name the same way", async () => {
  const index: Quote = {
    symbol: "^GSPC", currency: "USD", price: 7811.54, change: 46.18, changePercent: 0.5947, previousClose: 7765.36,
    changeSessionDate: "2026-10-09", marketState: "CLOSED", instrumentType: "INDEX", lastUpdated: Date.parse("2026-10-09T21:00:00Z"),
  };
  const indices = await run("indices", [], [index]);
  expect(indices.rows[0]).toMatchObject({ price: 7811.54, changePercent: 0.59, extendedSession: null });
  expect(indices.line("^GSPC")).toMatch(/7,811\.54 +\+0\.59%$/);

  spyOn(apiClient, "getMarketTrending").mockResolvedValue({ status: "success", data: [{ symbol: "AAPL" }, { symbol: "NVDA" }] } as never);
  const { rows, line } = await run("movers", ["trending"], [sessionQuotes("AAPL").weekend, sessionQuotes("NVDA").regular]);
  expect(rows.map(({ symbol, price, extendedPrice }) => ({ symbol, price, extendedPrice }))).toEqual([
    { symbol: "AAPL", price: 198.78, extendedPrice: 198.8 },
    { symbol: "NVDA", price: 199.1, extendedPrice: null },
  ]);
  expect(line("AAPL")).toMatch(/\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/);
});

test("movers gainers and active headline each row's regular session from the sessions the server sends", async () => {
  // As /market/movers sends a row: the live print it is ranked by, and its quote's sessions beside it.
  const listed = (quote: Quote) => ({
    symbol: quote.symbol, name: `${quote.symbol} Inc.`, price: quote.price, change: quote.change, changePercent: quote.changePercent,
    previousClose: quote.previousClose, volume: 2_000_000, currency: "USD", exchange: "NASDAQ", lastUpdated: quote.lastUpdated,
    ...moverSessionPayload(quote),
  });
  const movers = spyOn(apiClient, "getMarketMovers");
  const list = async (name: string, quotes: Quote[]) => {
    movers.mockResolvedValue({ status: "success", data: { quotes: quotes.map(listed), source: "gloom", stale: false, asOf: "2026-10-10T20:00:00Z" } } as never);
    return run("movers", [name], []);
  };
  try {
    for (const state of ["weekend", "afterHours", "preMarket"] as const) {
      const quote = sessionQuotes()[state];
      const headline = getRegularSessionDisplay(quote)!;
      const extended = getExtendedSessionDisplay(quote)!;
      // XLK closed up, so Losers has no place for it.
      for (const name of ["gainers", "active"]) {
        const { rows, text, line } = await list(name, [quote]);
        expect(rows[0]).toMatchObject({
          symbol: "XLK", price: headline.price, change: headline.change, changePercent: headline.changePercent,
          extendedSession: extended.session, extendedPrice: extended.price, extendedChangePercent: extended.changePercent,
        });
        expect(rows[0]).not.toHaveProperty("sessions");
        expect(text).toContain(state === "preMarket" ? "Pre-Market" : "After Hours");
        expect(line("XLK")).toMatch(state === "preMarket" ? /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/ : /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/);
      }
    }

    // WFF on Saturday: Friday's close of 12.29, +499.51% from 2.05, then a 9.99 after-hours print.
    const wff: Quote = {
      ...sessionQuotes("WFF").weekend, price: 9.99, change: 7.94, changePercent: 387.32, previousClose: 2.05,
      regularClose: 12.29, regularChange: 10.24, regularChangePercent: 499.51,
    };
    const gainers = await list("gainers", [sessionQuotes().weekend, wff]);
    expect(gainers.rows.map((row) => row.symbol)).toEqual(["WFF", "XLK"]);
    expect(gainers.line("WFF")).toMatch(/\$12\.29 +\+499\.51% +\$9\.99 -18\.71%/);

    // In the regular session the list is the live quote, with no extended column.
    const open = await list("active", [sessionQuotes().regular]);
    expect(open.rows[0]).toMatchObject({ price: 199.1, changePercent: 0.6674, extendedSession: null, extendedPrice: null });
    expect(open.text).not.toMatch(/After Hours|Pre-Market/);
  } finally {
    movers.mockRestore();
  }
});

test("after the close movers ranks Gainers by the regular-session move it shows, or by the after-hours move with --session extended, and says which", async () => {
  // Saturday: each closed Friday from 50 and printed after hours.
  const closed = (symbol: string, close: number, last: number) => ({
    symbol, name: `${symbol} Inc.`, price: last, change: last - 50, changePercent: (last / 50 - 1) * 100, previousClose: 50,
    volume: 2_000_000, currency: "USD", exchange: "NASDAQ", lastUpdated: Date.parse("2026-10-09T23:58:00Z"),
    regularClose: close, regularCloseSessionDate: "2026-10-09", regularChange: close - 50, regularChangePercent: (close / 50 - 1) * 100,
    changeSessionDate: "2026-10-09", marketState: "CLOSED",
  });
  const movers = spyOn(apiClient, "getMarketMovers").mockResolvedValue({ status: "success", data: { source: "gloom", stale: false,
    asOf: "2026-10-10T00:00:00Z", quotes: [
      // As the server ranks them, by the latest print: CCC +58%, AAA +20%, BBB +8%.
      closed("CCC", 48.2, 79), closed("AAA", 52.5, 60), closed("BBB", 55, 54),
    ] } } as never);
  try {
    const regular = await run("movers", ["gainers"], []);
    // CCC closed down 3.6%: up 64% after hours, it is no regular-session gainer.
    expect(regular.rows.map((row) => [row.symbol, round(row.changePercent as number)])).toEqual([["BBB", 10], ["AAA", 5]]);
    expect(regular.text.split("\n")[0]).toBe("Ranked by the regular-session move");
    const extended = await run("movers", ["gainers", "--session", "extended"], []);
    expect(extended.rows.map((row) => [row.symbol, round(row.extendedChangePercent as number)])).toEqual([["CCC", 63.9], ["AAA", 14.29]]);
    expect(extended.text.split("\n")[0]).toBe("Ranked by the after-hours move");
    // A list asks for more than it shows, so the rows a closed session drops leave it full.
    expect(movers.mock.calls.every(([, count]) => count === 50)).toBe(true);
  } finally {
    movers.mockRestore();
  }
});

test("movers --min-float keeps the rows whose float is at least the minimum, with a Float column that says it is partial", async () => {
  const row = (symbol: string, changePercent: number, floatShares?: number) => ({
    symbol, name: `${symbol} Inc.`, price: 10, change: changePercent / 10, changePercent, volume: 2_000_000, currency: "USD", exchange: "NASDAQ",
    lastUpdated: Date.parse("2026-10-09T17:00:00Z"),
    ...(floatShares == null ? {} : { floatShares, floatSharesState: "partial", floatSharesReason: "The source does not say when it measured this float" }),
  });
  const movers = spyOn(apiClient, "getMarketMovers").mockResolvedValue({ status: "success", data: { source: "gloom", stale: false,
    asOf: "2026-10-09T17:00:00Z", quotes: [row("TINY", 40, 2e6), row("NONE", 30), row("MID", 20, 15e6)] } } as never);
  try {
    const filtered = await run("movers", ["active", "--min-float", "10m"], []);
    expect(filtered.rows.map((entry) => entry.symbol)).toEqual(["MID"]);
    expect(filtered.text).toMatch(/Float/);
    expect(filtered.line("MID")).toMatch(/15M$/);
    expect(filtered.text).toContain("Float is partial: the source does not say when it measured it.");
    expect(filtered.rows[0]).toMatchObject({ floatSharesState: "partial" });
    // Most active reads as many candidates as the price lists once a minimum drops rows.
    expect(movers.mock.calls.at(-1)?.[1]).toBe(50);
    const all = await run("movers", ["active"], []);
    expect(all.rows).toHaveLength(3);
    expect(all.text).not.toMatch(/Float/);
    expect(all.text).not.toContain("partial");
  } finally {
    movers.mockRestore();
  }
});
