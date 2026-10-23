import { expect, setSystemTime, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote, TickerFinancials } from "../../types/financials";
import type { HeadlessPaneContext } from "../../types/headless";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { sessionQuotes } from "../../test-support/test-fixture-session-quotes";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { renderHeadlessPaneText } from "../pane-functions/headless";
import { quoteComparisonHeadless } from "../../plugins/builtin/ticker-detail/headless";
import { relativeValuationHeadless } from "../../plugins/builtin/research/relative-valuation-headless";
import { boardHeadlineQuote } from "../../plugins/builtin/shared/use-quote-board";
import { deriveHeadlessFreshness } from "../pane-functions/freshness";
import { quotesFreshness, valuationFreshness } from "../freshness";
import { marketDataCliCommands } from "./market";
import { buildTickerReport } from "./ticker";

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

test("ticker names the book out of regular hours: the extended session's, or a closed market's last quote; an open book stays bare", async () => {
  const book = { ...afterHours, bid: 202, ask: 208.74, bidSize: 100, askSize: 1400 };
  const report = (quote: Quote) => buildTickerReport({
    symbol: quote.symbol,
    tickerFile: null,
    financials: { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } as unknown as TickerFinancials,
    config,
    toBase: async (value) => value,
  });
  expect(await report(book)).toContain("Bid / Ask  $202.00 x 100 / $208.74 x 1,400  (last quote, Fri 9 Oct)");
  // ITA at 17:45 ET: the book beside Last and the After Hours print is the after-hours one.
  expect(await report({ ...book, marketState: "POST" })).toContain("Bid / Ask  $202.00 x 100 / $208.74 x 1,400  (after-hours book)");
  expect(await report({ ...book, marketState: "PRE" })).toContain("(pre-market book)");
  expect(await report({ ...book, marketState: "REGULAR" })).toMatch(/Bid \/ Ask +\$202\.00 x 100 \/ \$208\.74 x 1,400\n/);
  // Without a quoted book there is nothing to date.
  expect(await report({ ...book, bid: undefined, ask: undefined })).not.toContain("last quote");
});

// NEM after Friday's close, as Gloom Cloud sends it: the price is the after-hours
// print and the served multiples and cap are measured at it; the close rides beside.
const printed: Quote = {
  symbol: "NEM", currency: "USD", price: 116.96, change: -0.88, changePercent: -0.7468, previousClose: 117.84,
  regularClose: 117.15, regularCloseSessionDate: "2026-10-09", regularChange: -0.69, regularChangePercent: -0.5855,
  changeSessionDate: "2026-10-09", marketState: "CLOSED", listingExchangeName: "NYSE", marketCap: 124_167_097_214,
  lastUpdated: Date.parse("2026-10-09T23:53:02Z"),
};
// WPM in the after-hours session with the print beside a price that is the close.
const besidePrint: Quote = {
  symbol: "WPM", currency: "USD", price: 138.11, change: -0.54, changePercent: -0.3895, previousClose: 138.65,
  postMarketPrice: 136.25, postMarketChange: -1.86, postMarketChangePercent: -1.3467, changeSessionDate: "2026-10-09",
  marketState: "POST", listingExchangeName: "NYSE", marketCap: 62_716_000_000, lastUpdated: Date.parse("2026-10-09T21:44:21Z"),
};

/**
 * Fundamentals as served beside `quote`: every price-derived figure measured at one print, `at` (the quote's price,
 * or an older print), but the caps at `capAt`, with 5B of net debt.
 */
function servedAt(quote: Quote, eps: number, at = quote.price, capAt = at): TickerFinancials {
  const shares = quote.marketCap! / capAt;
  const enterpriseValue = shares * at + 5e9;
  return { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals: {
    eps, trailingPE: at / eps, dividendRate: 1.04, dividendYield: 1.04 / at, dividendYieldBasis: "forward",
    marketCap: quote.marketCap, marketCapCurrency: "USD", sharesOutstanding: shares,
    enterpriseValue, revenue: 50e9, enterpriseToRevenue: enterpriseValue / 50e9,
    financialCurrency: "USD", source: "gloom", fetchedAt: "2026-10-03T19:16:07Z",
  } };
}

test("quote, RV and valuation read the same close after hours, with the extended print in its own column", async () => {
  // NEM's figures were measured at a print a little older than the quote's; AAPL's cap is already the close's.
  const financials = new Map([servedAt(printed, 7.93, 116.9), servedAt(besidePrint, 4.57), servedAt({ ...afterHours, marketCap: 4.987e12 }, 7.46, 336.08, 336.64)]
    .map((entry) => [entry.quote!.symbol, entry]));
  const symbols = [...financials.keys()];
  const closes = [117.15, 138.11, 336.64];
  const capMeasuredAt = [116.9, 138.11, 336.64];
  const saturday = Date.parse("2026-10-10T12:00:00Z");
  // Read on the Saturday the quotes are from: a later week would find them a session behind.
  setSystemTime(saturday);

  const quoted = await compare(symbols.map((symbol) => financials.get(symbol)!.quote!));
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    getTickerFinancials: async (symbol) => financials.get(symbol)!,
  }) } as HeadlessPaneContext;
  const args = { symbols, argument: symbols, rawArgument: symbols.join(","), options: {} };
  const peers = await relativeValuationHeadless.load(args, ctx);
  const valuations = await Promise.all(symbols.map(async (symbol) => {
    const cli = createTestCliContext({ dataProvider: { getTickerFinancials: async () => financials.get(symbol)! } }, { format: "csv" });
    await marketDataCliCommands.find((command) => command.name === "valuation")!.execute([symbol], cli.context);
    const [{ result, options }] = cli.printed as [PrintedCliResult];
    const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options);
    const metric = (label: string) => Number(csv.split("\n").find((line) => line.startsWith(`${label},`))?.split(",")[1]);
    return { freshness: result.freshness, metric };
  }));

  symbols.forEach((symbol, index) => {
    const close = closes[index]!;
    const { quote, fundamentals } = financials.get(symbol)!;
    const [row, quoteRow, valuation] = [peers.rows[index]!, quoted.rows[index]!, valuations[index]!];
    // Last and Chg% are the regular close and its move in all three.
    expect([quoteRow.rawPrice, row.price, valuation.metric("Last (USD)")]).toEqual([close, close, close]);
    expect(Number(row.changePercent)).toBeCloseTo(Number(quoteRow.changePercent), 2);
    expect(valuation.metric("Change (%)")).toBeCloseTo(Number(quoteRow.changePercent), 2);
    // The print is the extended column alone, measured from that close.
    expect([row.extendedPrice, valuation.metric("After Hours (USD)")]).toEqual([quoteRow.rawExtendedPrice, quoteRow.rawExtendedPrice]);
    // Every price-derived figure is measured at the close: P/E x EPS is the close, the cap, the yield and EV move with it.
    expect(Number(row.trailingPE) * fundamentals!.eps!).toBeCloseTo(close, 6);
    expect(valuation.metric("P/E (TTM)") * fundamentals!.eps!).toBeCloseTo(close, 6);
    expect(Number(row.marketCap)).toBeCloseTo(quote!.marketCap! * close / capMeasuredAt[index]!, 0);
    expect(valuation.metric("Market Cap (USD)")).toBeCloseTo(Number(row.marketCap), 0);
    expect(valuation.metric("Dividend Yield (forward) (%)")).toBeCloseTo(104 / close, 6);
    expect(valuation.metric("Enterprise Value (USD)")).toBeCloseTo(Number(row.marketCap) + 5e9, 0);
    expect(Number(row.evSales) * 50e9).toBeCloseTo(Number(row.marketCap) + 5e9, -1);
    // Dated by its quote as `quote` dates it, by that quote's trading day close, never by when the fundamentals were fetched.
    expect(valuation.freshness?.asOf).toBe(new Date(quote!.lastUpdated).toISOString());
    expect(valuationFreshness(financials.get(symbol)!, saturday)).toMatchObject({ asOfClose: "2026-10-09", tradingDayMarket: "US" });
    expect(quotesFreshness([quote], undefined, saturday)).toMatchObject({ asOfClose: "2026-10-09" });
  });
  expect(renderHeadlessPaneText(relativeValuationHeadless, peers, args, "Relative Valuation"))
    .toMatch(/NEM +\$117\.15 +-0\.59% +\$116\.96 -0\.16% +124\.43B USD/);
  expect(deriveHeadlessFreshness(relativeValuationHeadless, peers, saturday)).toMatchObject({ asOfClose: "2026-10-09" });
  setSystemTime();
});

test("quote gives the overnight session its own column and names it, saying when its price is a midpoint", async () => {
  const traded = sessionQuotes("XLK").overnight;
  const marked = sessionQuotes("XLE").overnightMark;
  // Sunday evening in New York, as the overnight quotes are.
  setSystemTime(new Date("2026-10-12T00:35:00Z"));
  const { rows, text } = await compare([traded, marked]).finally(() => setSystemTime());
  expect(rows.map(({ rawPrice, changePercent, extendedSession, rawExtendedPrice, extendedChangePercent, extendedMark, session }) =>
    ({ rawPrice, changePercent, extendedSession, rawExtendedPrice, extendedChangePercent, extendedMark, session }))).toEqual([
    { rawPrice: 198.78, changePercent: 0.51, extendedSession: "OVERNIGHT", rawExtendedPrice: 198.95, extendedChangePercent: 0.09, extendedMark: false, session: "OVERNIGHT" },
    { rawPrice: 198.78, changePercent: 0.51, extendedSession: "OVERNIGHT", rawExtendedPrice: 198.95, extendedChangePercent: 0.09, extendedMark: true, session: "OVERNIGHT" },
  ]);
  expect(text).toMatch(/Chg% +Chg Basis +Overnight +Session/);
  // Friday's move, from Thursday's close; the overnight print moves from Friday's.
  expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(/\$198\.78 +\+0\.51% +vs Thu 8 Oct close +\$198\.95 \+0\.09% +OVERNIGHT/);
  expect(text.split("\n").find((line) => line.startsWith("XLE"))).toMatch(/\$198\.95 mid \+0\.09% +OVERNIGHT/);
  expect(text).not.toMatch(/After Hours|Pre-Market/);
});

// Linear: GLO-1089. The table sets what Chg% is from beside it; an export adds it after the columns it had.
test("quote's change basis follows Chg% in the table, with the holiday under it, and comes last in CSV and NDJSON rows", async () => {
  const hk: Quote = { symbol: "3042.HK", name: "ChinaAMC Bitcoin ETF", currency: "HKD", price: 9.88, change: -0.06, changePercent: -0.6,
    previousClose: 9.94, changeSessionDate: "2026-10-20", marketState: "CLOSED", listingExchangeName: "HKEX", exchangeName: "HKEX",
    lastUpdated: Date.parse("2026-10-20T08:08:00Z") };
  setSystemTime(new Date("2026-10-21T00:30:00Z"));
  try {
    const cli = createTestCliContext({ config, dataProvider: {
      getQuotesBatch: async () => [{ target: { symbol: hk.symbol, exchange: "" }, quote: hk }],
    } });
    await marketDataCliCommands.find((command) => command.name === "quote")!.execute([hk.symbol], cli.context);
    const [{ result, options }] = cli.printed as [PrintedCliResult];
    const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options);
    expect(text).toMatch(/Chg% +Chg Basis +Session/);
    expect(text).toMatch(/-0\.60% +vs Fri 16 Oct close +CLOSED/);
    expect(text).toContain("\nHKEX closed Mon 19 Oct, holiday");
    const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
    expect(csv[0]).toContain(",Chg%,Pre-Market,");
    expect(csv[0]).toContain(",Updated,Chg Basis,Chg Basis Note,Pre-Market Chg%,After Hours Chg%,Overnight Chg%,status,symbol_or_series,");
    expect(csv[1]).toContain(",vs Fri 16 Oct close,\"HKEX closed Mon 19 Oct, holiday\",,,,,3042.HK,");
    const row = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "ndjson" }, options).split("\n")[0]!);
    const keys = Object.keys(row);
    expect(keys.slice(keys.indexOf("error"), keys.indexOf("error") + 3)).toEqual(["error", "changeBasis", "changeBasisNote"]);
  } finally {
    setSystemTime();
  }
});

test("a pre-market nothing has traded in reads as the close it stands at in quote, QQ, the boards and the watchlist, and exports keep the state", async () => {
  // PLTR on Fri 16 Oct 2026 at 08:14 UTC: no pre-market trade; the price is Thursday's last after-hours print at 23:59 UTC.
  const waiting: Quote = {
    symbol: "PLTR", name: "Palantir Technologies Inc.", currency: "USD", price: 200.66, change: 0.16, changePercent: 0.0798,
    previousClose: 200.5, regularClose: 200.5, regularCloseSessionDate: "2026-10-15", regularChange: -0.47, regularChangePercent: -0.2339,
    changeSessionDate: "2026-10-16", marketState: "PRE", extendedSessionPrint: false, listingExchangeName: "NASDAQ",
    lastUpdated: Date.parse("2026-10-15T23:59:00Z"),
  };
  // Another name that has traded in it, at 08:03:45.
  const printed: Quote = { ...waiting, symbol: "SOFI", price: 201.29, preMarketPrice: 201.29, extendedSessionPrint: true,
    lastUpdated: Date.parse("2026-10-16T08:03:45Z") };
  const thursdayClose = "2026-10-15T20:00:00.000Z";
  setSystemTime(new Date("2026-10-16T08:14:00Z"));
  try {
    const { rows, text } = await compare([waiting, printed]);
    expect(rows.map(({ session, sessionLabel, updatedAt }) => ({ session, sessionLabel, updatedAt }))).toEqual([
      { session: "PRE-MKT", sessionLabel: "Thu close", updatedAt: thursdayClose },
      { session: "PRE-MKT", sessionLabel: "PRE-MKT", updatedAt: "2026-10-16T08:03:45.000Z" },
    ]);
    expect(text.split("\n").find((line) => line.startsWith("PLTR"))).toContain("Thu close");
    // CSV keeps the state the Session column always held.
    const cli = createTestCliContext({ config, dataProvider: {
      getQuotesBatch: async () => [{ target: { symbol: "PLTR", exchange: "" }, quote: waiting }],
    } });
    await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["PLTR"], cli.context);
    const [{ result, options }] = cli.printed as [PrintedCliResult];
    const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
    expect(csv[1]).toContain(`,PRE-MKT,USD,`);
    expect(csv[1]).toContain(thursdayClose);

    // QQ, a board's row and the watchlist report date it by the same close.
    const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({ getQuote: async () => waiting }) } as HeadlessPaneContext;
    const board = await quoteComparisonHeadless.load({ symbols: ["PLTR"], argument: ["PLTR"], rawArgument: "PLTR", options: {} }, ctx);
    expect(board.rows[0]).toMatchObject({ price: 200.5, extendedSession: null, updatedAt: Date.parse(thursdayClose) });
    expect(boardHeadlineQuote(waiting)).toMatchObject({ price: 200.5, change: -0.47, lastUpdated: Date.parse(thursdayClose) });
    // A quote with a pre-market trade keeps its time.
    expect(boardHeadlineQuote(printed).lastUpdated).toBe(printed.lastUpdated);
  } finally {
    setSystemTime();
  }
});

// A quote export is read by a script: numbers in number cells, a print's move in its own column,
// and every empty row says why, on stderr as well as in the file (GLO-1263).
test("quote --csv writes plain numbers, an extended print and its move apart, and a status for every row it has no figure for", async () => {
  const failed = { symbol: "ZZZZQQ", exchange: "" };
  const unmeasured: Quote = { ...closed, symbol: "0QQQ.L", currency: "GBP", price: 12.5, change: Number.NaN, changePercent: Number.NaN,
    previousClose: 0, listingExchangeName: "LSE" };
  setSystemTime(new Date("2026-10-10T12:00:00Z"));
  try {
    const cli = createTestCliContext({ config, dataProvider: createTestDataProvider({
      getQuotesBatch: async () => [
        ...[afterHours, closed, unmeasured].map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
        { target: failed, quote: null, error: new Error("Not a ticker: ZZZZQQ.") },
      ],
    }) }, { format: "csv" });
    await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["AAPL", "7203.T", "0QQQ.L", "ZZZZQQ"], cli.context);
    const [{ result, options }] = cli.printed as [PrintedCliResult];
    const [header, ...lines] = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n\n")[0]!.split("\n");
    const columns = header!.split(",");
    const rows = lines.map((line) => line.match(/("[^"]*"|[^,]*)(,|$)/g)!.map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "")));
    const cell = (symbol: string, column: string) => rows.find((row) => row[0] === symbol)![columns.indexOf(column)];
    expect(columns.slice(-9)).toEqual(["Pre-Market Chg%", "After Hours Chg%", "Overnight Chg%", "status",
      "symbol_or_series", "currency_or_unit", "interval", "source", "as_of"]);
    expect([cell("AAPL", "Last"), cell("AAPL", "After Hours"), cell("AAPL", "After Hours Chg%"), cell("AAPL", "status")]).toEqual(["336.64", "336.08", "-0.17", ""]);
    expect([cell("7203.T", "Last"), cell("7203.T", "Cur"), cell("7203.T", "currency_or_unit")]).toEqual(["2910.5", "JPY", "JPY"]);
    expect([cell("0QQQ.L", "Last"), cell("0QQQ.L", "Chg%"), cell("0QQQ.L", "status")]).toEqual(["12.5", "", "Chg%: no previous close"]);
    expect([cell("ZZZZQQ", "Last"), cell("ZZZZQQ", "status")]).toEqual(["", "Not a ticker: ZZZZQQ."]);
    // The failure is on stderr too, where a script that pipes the rows to a file still sees it.
    expect(result.warnings).toContain("Not a ticker: ZZZZQQ.");
  } finally {
    setSystemTime();
  }
});
