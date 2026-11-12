import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { exportNumber } from "../../../../cli/report-tables";
import { serializeCliResult } from "../../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { renderHeadlessPaneText } from "../../../../cli/pane-functions/headless";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../../market-data/market/status";
import { createDefaultConfig } from "../../../../types/config";
import type { HeadlessPaneContext } from "../../../../types/headless";
import type { Quote } from "../../../../types/financials";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { sessionQuotes } from "../../../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import { collectionHoldingsHeadless } from "../headless";
import { showCollection } from "./render";
import { portfolioCliCommand } from "./portfolio-command";

afterEach(() => {
  setCliColorEnabledOverride(null);
  setSystemTime();
});

const config = {
  ...createDefaultConfig("/unused-collection-sessions"),
  portfolios: [{ id: "main", name: "Main", currency: "USD" }],
  watchlists: [{ id: "tech", name: "Tech" }],
};
const held = createTestTicker("XLK", "Technology Select Sector SPDR", {
  exchange: "ARCA", portfolios: ["main"], watchlists: ["tech"],
  positions: [{ portfolio: "main", shares: 10, avgCost: 150, currency: "USD", broker: "manual" }],
});

/** `portfolio show Main` and `watchlist show Tech` with XLK quoted as `quote`: the text, and the portfolio's JSON row. */
async function show(quote: Quote) {
  const market = { config, store: { loadAllTickers: async () => [held] }, dataProvider: createTestDataProvider({ getQuote: async () => quote }) };
  setCliColorEnabledOverride(false);
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try {
    await showCollection("Main", createTestCliContext(market).context);
    await showCollection("Tech", createTestCliContext(market).context);
  } finally { logger.mockRestore(); }
  const cli = createTestCliContext(market, { format: "json" });
  await showCollection("Main", cli.context);
  const json = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  const text = output.join("\n");
  return { text, rows: text.split("\n").filter((line) => line.startsWith("XLK")), json: json.data[0] };
}

test("portfolio and watchlist show headline the regular close beside the extended print, and value at the live price", async () => {
  for (const state of ["weekend", "afterHours", "preMarket", "overnight"] as const) {
    const quote = sessionQuotes()[state];
    // Read in the session it is from, so the print is current rather than a stale row.
    setSystemTime(quote.lastUpdated + 3_600_000);
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    const { text, rows, json } = await show(quote);
    const figures = {
      weekend: /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/,
      afterHours: /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/,
      preMarket: /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/,
      overnight: /\$198\.78 +\+0\.51% +\$198\.95 \+0\.09%/,
    }[state];
    expect(text).toContain({ weekend: "After Hours", afterHours: "After Hours", preMarket: "Pre-Market", overnight: "Overnight" }[state]);
    // The portfolio's row, then the watchlist's.
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatch(figures);
    // JSON writes the move as every export does, its float noise dropped.
    expect(json).toMatchObject({ quotePrice: headline.price, extendedSession: extended.session, extendedPrice: extended.price,
      extendedChange: exportNumber(extended.change!), extendedChangePercent: exportNumber(extended.changePercent!) });
    // The position is still worth its shares at the live print.
    expect(json.marketValue).toBeCloseTo(10 * extended.price, 8);
  }

  const open = await show(sessionQuotes().regular);
  expect(open.text).not.toMatch(/After Hours|Pre-Market/);
  for (const row of open.rows) expect(row).toMatch(/\$199\.10 +\+0\.67%/);
  expect(open.json).toMatchObject({ quotePrice: 199.1, extendedSession: null, extendedPrice: null, marketValue: 1991 });
});

test("PF reports a portfolio's and a watchlist's rows the same way", async () => {
  const { weekend } = sessionQuotes();
  const ctx = {
    config, signal: new AbortController().signal,
    marketData: createTestDataProvider({ getQuote: async () => weekend }),
    resolvePortfolio: async () => ({ portfolio: config.portfolios[0], tickers: [held] }),
    resolveWatchlist: async () => [held],
  } as unknown as HeadlessPaneContext;
  setCliColorEnabledOverride(false);
  for (const name of ["Main", "Tech"]) {
    const args = { rawArgument: name, argument: name, symbols: [], options: {} };
    const result = await collectionHoldingsHeadless.load(args, ctx);
    expect(result.rows[0]).toMatchObject({ symbol: "XLK", price: 198.78, changePercent: 0.5056, extendedSession: "POST", extendedPrice: 198.8 });
    const text = renderHeadlessPaneText(collectionHoldingsHeadless, result, args, "PF");
    expect(text).toContain("After Hours");
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(/198\.78 .*\+0\.51% +198\.80 \+0\.01%/);
  }
});

describe("what a portfolio is priced at and when each row's price is from", () => {
  // Over the weekend: XLK's last after-hours print beside Friday's close, and a listing with no extended hours.
  const xlk = createTestTicker("XLK", "Technology Select Sector SPDR", {
    exchange: "ARCA", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 1000, avgCost: 150, currency: "USD", broker: "manual" }],
  });
  const sap = createTestTicker("SAP", "SAP SE", {
    exchange: "XETRA", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 50, avgCost: 180, currency: "USD", broker: "manual" }],
  });
  const quotes: Record<string, Quote> = {
    XLK: sessionQuotes().weekend,
    SAP: { symbol: "SAP", currency: "USD", price: 200, change: 4, changePercent: 2.0408, previousClose: 196,
      listingExchangeName: "XETRA", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T15:38:00Z") },
  };
  const market = { config, store: { loadAllTickers: async () => [xlk, sap] },
    dataProvider: createTestDataProvider({ getQuote: async (symbol) => quotes[symbol]! }) };
  const day = (time: string) => new RegExp(`Fri 9 Oct (2026 )?${time}`);

  async function showText(args: string[]) {
    setCliColorEnabledOverride(false);
    const output: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...line) => { output.push(line.join(" ")); });
    try { await portfolioCliCommand.execute(args, createTestCliContext(market).context); } finally { logger.mockRestore(); }
    return output.join("\n");
  }
  async function showExport(args: string[], format: "json" | "csv") {
    const cli = createTestCliContext(market, { format });
    await portfolioCliCommand.execute(args, cli.context);
    return serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format }, cli.printed[0]!.options);
  }

  test("by default the value is the latest print, said under the title, with each row's print time and the value's move totalled with its base", async () => {
    const text = await showText(["show", "Main"]);
    expect(text).toContain("Priced at the latest print, extended hours included");
    expect(text).toContain("As of (UTC)");
    // XLK's after-hours 198.80 is 1.02 a share over Thursday's close, SAP 4.00 over a close nothing dates: TOTAL's Chg is the value's move.
    expect(text).toMatch(/TOTAL +\+0\.59% /);
    expect(text).toContain("Day's move: +$1,220.00 (+0.59%) after hours vs mixed closes");
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(new RegExp(`\\$198,800 .*${day("23:58").source}`));
    expect(text.split("\n").find((line) => line.startsWith("SAP"))).toMatch(day("15:38"));

    const json = JSON.parse(await showExport(["show", "Main"], "json"));
    expect(json.metadata).toMatchObject({ valuationBasis: "latest-print", dayChange: 1220, dayChangeBasis: "after hours vs mixed closes" });
    expect(json.data[1]).toMatchObject({ symbol: "XLK", quotePrice: 198.78, marketValue: 198_800, priceBasis: null,
      valuationBasis: "latest-print", valuationPrice: 198.8, valuationAsOf: "2026-10-09T23:58:08.000Z", quoteAsOf: Date.parse("2026-10-09T23:58:08Z") });
  });

  test("a book across markets dates each one's session and names when each opens, not the newest market's day with another's open", async () => {
    setSystemTime(new Date("2026-10-10T13:00:00Z"));
    try {
      expect(await showText(["show", "Main"])).toContain("Source: Local portfolio and Gloom Cloud · XETRA and US Fri 9 Oct 2026 close · markets closed · "
        + "XETRA opens Mon 07:00 UTC, 09:00 CET · US Mon 13:30 UTC, 09:30 ET");
    } finally {
      setSystemTime();
    }
  });

  // `portfolio show Tarim --close` with New York open said "Priced at the regular close" over NYSE rows at 19:56 prints.
  test("--close with a market still in its session says which markets are at their close and which still trade", async () => {
    const weekend = quotes.XLK!;
    quotes.XLK = sessionQuotes().regular;
    setSystemTime(new Date("2026-10-09T17:05:00Z"));
    try {
      expect(await showText(["show", "Main", "--close"])).toContain("Priced at the regular close: XETRA at its close; US still trading, at the latest print");
    } finally {
      quotes.XLK = weekend;
      setSystemTime();
    }
  });

  test("--close values every row at Last times its shares, totals them, and says the day's move and the close time", async () => {
    const text = await showText(["show", "Main", "--close"]);
    expect(text).toContain("Priced at the regular close");
    // ARCA closes at 16:00 New York time.
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(new RegExp(`\\$198\\.78 .*\\$198,780 .*${day("20:00").source}`));
    expect(text).toMatch(/TOTAL .*\$208,780/);
    // XLK +1.00 a share, SAP +4.00, from 197.78 and 196: Thursday's ARCA close and a XETRA close nothing dates.
    expect(text).toContain("Day's move: +$1,200.00 (+0.58%) vs mixed closes");

    const json = JSON.parse(await showExport(["show", "Main", "--close"], "json"));
    for (const row of json.data) expect(row.marketValue).toBe(row.quotePrice * row.shares);
    expect(json.data.map((row: { valuationAsOf: string }) => row.valuationAsOf)).toEqual(["2026-10-09T15:38:00.000Z", "2026-10-09T20:00:00.000Z"]);
    expect(json.metadata).toMatchObject({ valuationBasis: "regular-close", total: 208_780, dayChange: 1200, dayChangeBasis: "vs mixed closes" });
    expect(json.metadata.dayChangePercent).toBeCloseTo(1200 / 207_580 * 100, 8);
    // Exports are dated by the close, name the basis, and cite the oldest price too.
    expect(json.source).toMatchObject({ observationDate: "2026-10-09T20:00:00.000Z", oldestObservationDate: "2026-10-09T15:38:00.000Z" });

    const csv = await showExport(["show", "Main", "--close"], "csv");
    const [header, ...lines] = csv.split("\n");
    // The valuation fields keep their place; the dividend fields come after them, before the five fixed columns every export ends with.
    expect(header!.split(",").slice(-13)).toEqual(["valuationBasis", "valuationPrice", "valuationAsOf",
      "dividendPerShare", "dividendCurrency", "annualIncome", "incomeYield", "symbol_or_series", "currency_or_unit", "interval", "source", "as_of", "retrieved_at"]);
    expect(lines.find((line) => line.startsWith("XLK"))).toMatch(/,regular-close,198\.78,2026-10-09T20:00:00\.000Z,,,,,XLK,[^,]*,,[^,]+,2026-10-09T20:00:00\.000Z,[^,]+$/);
    expect(csv).toMatch(/# Source: .* · priced at the regular close\n/);
    expect(csv).toContain("# Observation date: 2026-10-09T20:00:00.000Z\n# Oldest observation: 2026-10-09T15:38:00.000Z\n");

    await expect(portfolioCliCommand.execute(["show", "Tech", "--close"], createTestCliContext(market).context)).rejects.toThrow("is a watchlist");
  });

  test("a US pre-market print's day move is measured from the close before it, as the pane's Day is", async () => {
    // Mon 12 Oct 08:30 ET: XLK's 199.50 is 0.72 over Friday's close.
    setSystemTime(new Date("2026-10-12T12:30:00Z"));
    const premarket = { config, store: { loadAllTickers: async () => [xlk] },
      dataProvider: createTestDataProvider({ getQuote: async () => sessionQuotes().preMarket }) };
    setCliColorEnabledOverride(false);
    const output: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...line) => { output.push(line.join(" ")); });
    try { await portfolioCliCommand.execute(["show", "Main"], createTestCliContext(premarket).context); } finally { logger.mockRestore(); }
    expect(output.join("\n")).toContain("Day's move: +$720.00 (+0.36%) pre-market vs Fri 9 Oct close");
  });

  test("PF --close reports the same values, each row's close time and the basis in its closing line", async () => {
    const ctx = {
      config, signal: new AbortController().signal, marketData: market.dataProvider,
      resolvePortfolio: async () => ({ portfolio: config.portfolios[0], tickers: [xlk, sap] }),
    } as unknown as HeadlessPaneContext;
    setCliColorEnabledOverride(false);
    const args = { rawArgument: "Main", argument: "Main", symbols: [], options: { close: true } };
    const result = await collectionHoldingsHeadless.load(args, ctx);
    expect(result.rows[0]).toMatchObject({ symbol: "XLK", price: 198.78, marketValue: 198_780, valuationAsOf: "2026-10-09T20:00:00.000Z" });
    const text = renderHeadlessPaneText(collectionHoldingsHeadless, result, args, "PF");
    expect(text).toContain("Day's move: +$1,200.00 (+0.58%)");
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(day("20:00"));
    expect(text).toMatch(/priced at the regular close$/);
  });
});

describe("a book across HKEX and the US, read on Mon 9 Nov 2026 before the US open", () => {
  const book = (symbol: string, exchange: string, currency: string, shares: number) => createTestTicker(symbol, symbol, {
    exchange, currency, portfolios: ["main"], positions: [{ portfolio: "main", shares, avgCost: 1, currency, broker: "manual" }],
  });
  const hkex = { listingExchangeName: "HKEX", exchangeName: "HKEX", instrumentType: "ETF", marketState: "CLOSED" as const };
  const quotes: Record<string, Quote> = {
    // Traded today on HKEX, from Friday's close.
    "3042.HK": { ...hkex, symbol: "3042.HK", currency: "HKD", price: 9.4, change: 0.22, changePercent: 2.3965, previousClose: 9.18,
      changeSessionDate: "2026-11-09", lastUpdated: Date.parse("2026-11-09T07:59:00Z") },
    // Its USD counter, untraded since 29 Oct: Monday's nominal price against Friday's, its last print a week old.
    "9042.HK": { ...hkex, symbol: "9042.HK", currency: "USD", price: 1.2, change: 0.028, changePercent: 2.389, previousClose: 1.172,
      changeSessionDate: "2026-11-09", lastUpdated: Date.parse("2026-11-04T03:32:00Z"), stale: true, volume: 0,
      nominalPrice: { session: "2026-11-09", lastTraded: "2026-10-29" } },
    // Pre-market in New York, 0.62 over Friday's close.
    IBIT: { symbol: "IBIT", currency: "USD", listingExchangeName: "NASDAQ", instrumentType: "ETF", price: 43.5, change: 0.62, changePercent: 1.4459,
      previousClose: 42.88, preMarketPrice: 43.5, preMarketChange: 0.62, preMarketChangePercent: 1.4459,
      regularClose: 42.88, regularCloseSessionDate: "2026-11-06", regularChange: -0.15, regularChangePercent: -0.3486,
      changeSessionDate: "2026-11-09", marketState: "PRE", lastUpdated: Date.parse("2026-11-09T12:55:00Z") },
    // Delisted years ago: its last session's change is not today's.
    TWTR: { symbol: "TWTR", currency: "USD", listingExchangeName: "NYSE", price: 53.86, change: 0.16, changePercent: 0.3, previousClose: 53.7,
      marketState: "CLOSED", lastUpdated: Date.parse("2022-10-27T20:00:00Z"),
      delisting: { status: "delisted", lastTradeDate: "2022-10-27", historyStart: "2016-01-04" } },
  };
  const market = {
    config,
    store: { loadAllTickers: async () => [book("3042.HK", "HKEX", "HKD", 1000), book("9042.HK", "HKEX", "USD", 1000), book("IBIT", "NASDAQ", "USD", 100), book("TWTR", "NYSE", "USD", 10)] },
    dataProvider: createTestDataProvider({ getQuote: async (symbol) => quotes[symbol]! }),
  };

  test("its day move is each print's from Friday's close, a delisted holding moving nothing, and a nominal price says so", async () => {
    setSystemTime(new Date("2026-11-09T13:00:00Z"));
    setCliColorEnabledOverride(false);
    const output: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...line) => { output.push(line.join(" ")); });
    try { await portfolioCliCommand.execute(["show", "Main"], createTestCliContext(market).context); } finally { logger.mockRestore(); }
    const text = output.join("\n");
    // 1000 x 0.22 + 1000 x 0.028 + 100 x 0.62, at one HKD to the dollar here; TWTR adds its value to the base and nothing to the move.
    expect(text).toContain("Day's move: +$310.00 (+2.04%) pre-market vs Fri 6 Nov close");
    expect(text.split("\n").find((line) => line.startsWith("9042"))).toMatch(/Mon 9 Nov nominal$/);

    const cli = createTestCliContext(market, { format: "json" });
    await portfolioCliCommand.execute(["show", "Main"], cli.context);
    const json = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, cli.printed[0]!.options));
    expect(json.metadata).toMatchObject({ dayChange: 310, dayChangeBasis: "pre-market vs Fri 6 Nov close" });
    // The counter keeps its last print as its quote time, and says its price is nominal, dated by its session.
    expect(json.data.find((row: { symbol: string }) => row.symbol === "9042.HK")).toMatchObject({ quoteAsOf: Date.parse("2026-11-04T03:32:00Z"),
      quotePriceKind: "nominal", valuationAsOf: "2026-11-09", valuationPriceKind: "nominal" });
    expect(text).toContain("1 of 4 stale, 1 of 4 nominal");
  });
});

// A lira book on Tue 10 Nov 2026 with New York open: its Day's move held the dollar names' price moves alone, at
// today's rate, about TRY1.9k of the lira's own move missing from a book three quarters in dollars.
test("a book's day move holds the currency move of a holding in another currency, as `fx` reads the pair", async () => {
  setSystemTime(new Date("2026-11-10T20:29:00Z"));
  setCliColorEnabledOverride(false);
  const lira = { ...config, portfolios: [{ id: "tarim", name: "Tarim", currency: "TRY" }] };
  const ntr = createTestTicker("NTR", "Nutrien", { exchange: "NYSE", currency: "USD", portfolios: ["tarim"],
    positions: [{ portfolio: "tarim", shares: 100, avgCost: 60, currency: "USD", broker: "manual" }] });
  // One ES contract (50 x the index): its contract value is no money held, so the dollar moves only its P&L.
  const es = createTestTicker("ES=F", "E-mini S&P 500", { exchange: "CME", currency: "USD", assetCategory: "FUTURE", portfolios: ["tarim"],
    positions: [{ portfolio: "tarim", shares: 1, avgCost: 6700, currency: "USD", broker: "manual", multiplier: 50 }] });
  const quotes: Record<string, Quote> = {
    NTR: { symbol: "NTR", currency: "USD", listingExchangeName: "NYSE", price: 72.57, change: 0.28, changePercent: 0.3873, previousClose: 72.29,
      changeSessionDate: "2026-11-10", marketState: "REGULAR", lastUpdated: Date.parse("2026-11-10T20:14:00Z") },
    "ES=F": { symbol: "ES=F", currency: "USD", listingExchangeName: "CME", price: 6810, change: 10, changePercent: 0.147, previousClose: 6800,
      changeSessionDate: "2026-11-10", marketState: "REGULAR", instrumentType: "FUTURE", lastUpdated: Date.parse("2026-11-10T20:14:00Z") },
    "USDTRY=X": { symbol: "USDTRY=X", currency: "TRY", price: 50.2294, change: 0.0518, changePercent: 0.1032, previousClose: 50.1776,
      instrumentType: "CURRENCY", lastUpdated: Date.parse("2026-11-10T20:28:00Z") },
  };
  const market = {
    config: lira,
    store: { loadAllTickers: async () => [ntr, es] },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => quotes[symbol]!,
      getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: quotes[target.symbol] ?? null })),
      getExchangeRate: async (currency) => currency === "TRY" ? 1 / 50.2294 : 1,
    }),
  };
  const cli = createTestCliContext(market, { format: "json" });
  await portfolioCliCommand.execute(["show", "Tarim"], cli.context);
  const json = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, cli.printed[0]!.options));
  // 100 x 72.29 dollars at the close before were worth 50.1776 lira each, and 100 x 72.57 are worth 50.2294 now.
  const fx = 100 * 72.29 * (50.2294 - 50.1776);
  const future = 50 * 10 * 50.2294;
  expect(json.metadata.dayChange).toBeCloseTo(100 * 72.57 * 50.2294 - 100 * 72.29 * 50.1776 + future, 6);
  expect(json.metadata.dayChangeFx).toBeCloseTo(fx, 6);
  expect(json.metadata.dayChangePercent).toBeCloseTo(
    (100 * 72.57 * 50.2294 - 100 * 72.29 * 50.1776 + future) / (100 * 72.29 * 50.1776 + 50 * 6800 * 50.2294) * 100, 6);
});
