import { afterEach, expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../market-data/market/status";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { moverSessionPayload, sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import type { CloudMarketScreenerItem } from "../../../api-client/types";
import { loadMarketMoverTab } from "./client";
import { createMarketMoversHeadless } from "./headless";
import { createRows, moverRegularSession, overlayMarketMoverQuotes, screenerQuoteFromQuote, type MoverQuote, type MoverRankBasis } from "./model";
import { fetchPreferredMarketMovers } from "./screener";
import { buildMarketMoverColumns, renderMarketMoverCell } from "./table";

afterEach(() => setCliColorEnabledOverride(null));

const args = { rawArgument: "", argument: null, symbols: [], options: { list: "trending" } };

/** MOST's trending list, every name quoted as XLK is in `state`. */
async function trending(state: keyof ReturnType<typeof sessionQuotes>) {
  const marketData = createTestDataProvider({ getQuotesBatch: async (targets) => targets.map((target) => ({
    target, quote: sessionQuotes(target.symbol)[state],
  })) });
  const headless = createMarketMoversHeadless({
    load: (_args, tab, provider) => loadMarketMoverTab(tab, provider, undefined, {
      fetchPreferred: async () => { throw new Error("unused"); },
      fetchTrending: async () => ({ data: [{ symbol: "XLK" }, { symbol: "AAPL" }], stale: false }),
    }),
    loadSession: async () => { throw new Error("unused"); },
  });
  const result = await headless.load(args, { marketData } as never);
  setCliColorEnabledOverride(false);
  return { rows: result.rows, text: renderHeadlessPaneText(headless, result, args, "MOST") };
}

test("trending lists the regular session's last and move, with an extended print in its own column", async () => {
  for (const state of ["weekend", "afterHours", "preMarket"] as const) {
    const quote = sessionQuotes()[state];
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    const { rows, text } = await trending(state);
    expect(rows[0]).toMatchObject({
      symbol: "XLK", rank: 1, price: headline.price, change: headline.change, changePercent: headline.changePercent,
      extendedSession: extended.session, extendedPrice: extended.price, extendedChangePercent: extended.changePercent,
    });
    expect(text.split("\n").find((line) => line.includes(" XLK "))).toMatch(state === "preMarket"
      ? /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/
      : /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/);
  }
  const open = await trending("regular");
  expect(open.rows[0]).toMatchObject({ price: 199.1, changePercent: 0.6674, extendedSession: null });
  expect(open.text).not.toMatch(/After Hours|Pre-Market/);
});

const ready = (quote: Quote): QueryEntry<Quote> => ({
  phase: "ready", data: quote, lastGoodData: quote, source: "gloomberb-cloud", fetchedAt: null, staleAt: null, error: null, attempts: [],
});

test("a live quote on a list row keeps the row's place and splits the close from the extended print", () => {
  const { afterHours, regular } = sessionQuotes();
  // The day's gainers as the list sent them, before the close.
  const listed: MoverQuote[] = [screenerQuoteFromQuote("XLK", regular), screenerQuoteFromQuote("AAPL", sessionQuotes("AAPL").regular)];
  const entries = new Map([[buildQuoteKey({ symbol: "XLK", exchange: listed[0]!.exchange }), ready(afterHours)]]);
  const [xlk, aapl] = overlayMarketMoverQuotes(listed, entries);
  expect(xlk).toMatchObject({ symbol: "XLK", price: 198.78, change: 1, changePercent: 0.5056, extended: getExtendedSessionDisplay(afterHours) });
  expect(aapl).toBe(listed[1]);

  const row = { ...xlk!, rank: 1 };
  const ids = (width: number) => buildMarketMoverColumns(width, ["POST"]).map((column) => column.id);
  expect(ids(100)).toEqual(["rank", "symbol", "name", "price", "changePercent", "afterHours", "volume", "volumeRatio", "range", "marketCap"]);
  const column = buildMarketMoverColumns(100, ["POST"]).find((entry) => entry.id === "afterHours")!;
  expect(column.label).toBe("AFTER-HRS");
  expect(renderMarketMoverCell(row, column).text).toBe("+0.01%");
  // A narrow pane gives up MCAP, then 52W%, before the names.
  expect(ids(88)).toEqual(["rank", "symbol", "name", "price", "changePercent", "afterHours", "volume", "volumeRatio", "range"]);
  expect(ids(80)).toEqual(["rank", "symbol", "name", "price", "changePercent", "afterHours", "volume", "volumeRatio"]);
  expect(buildMarketMoverColumns(100).map((entry) => entry.id)).not.toContain("afterHours");
});

test("before the open a live quote keeps the session the list ranked its rows by, with that session's volume", () => {
  // Pre-market, Gainers lists Wednesday's closes. SLXN's live quote reports Wednesday's close but not its
  // move (its 1-for-24 split that day), so its own figures are Wednesday's after-hours print against that
  // close: +8.36%, which once sat at rank 9 among +23% moves. Neither quote counts a volume for Thursday yet.
  const premarket = { currency: "USD", listingExchangeName: "NASDAQ", marketState: "PRE", changeSessionDate: "2026-11-12",
    regularCloseSessionDate: "2026-11-11", lastUpdated: Date.parse("2026-11-12T09:10:00Z") } as const;
  // The live list names each row by its symbol; the quotes name the company.
  const listed = (symbol: string, close: number, previous: number, volume: number, avgVolume: number) => moverRegularSession({
    symbol, name: symbol, price: close, change: close - previous, changePercent: (close / previous - 1) * 100, volume, avgVolume,
    volumeRatio: volume / avgVolume, marketCap: undefined, currency: "USD", exchange: "NASDAQ", previousClose: previous,
    fiftyTwoWeekHigh: undefined, fiftyTwoWeekLow: undefined, dayHigh: undefined, dayLow: undefined,
    sessions: { ...premarket, regularClose: close, regularChange: close - previous, regularChangePercent: (close / previous - 1) * 100 },
  });
  const rows = [listed("NXXT", 1.7, 0.1865, 150_571_444, 8_234_259), listed("SLXN", 3.23, 2.6136, 294_106, 61_276)];
  expect(rows.map((row) => [row.changePercent?.toFixed(2), row.closedSession])).toEqual([["811.53", "2026-11-11"], ["23.58", "2026-11-11"]]);
  const quotes = [
    { ...premarket, symbol: "NXXT", name: "NextNRG, Inc.", price: 2.0598, change: 0.3598, changePercent: 21.16, previousClose: 1.7,
      regularClose: 1.7, regularChange: 1.5135, regularChangePercent: 811.53 },
    { ...premarket, symbol: "SLXN", name: "Silexion Therapeutics Corp", price: 3.5, change: 0.27, changePercent: 8.36, previousClose: 3.23,
      regularClose: 3.23, preMarketPrice: 3.5, preMarketChange: 0.27, preMarketChangePercent: 8.36 },
  ] as Quote[];
  const entries = new Map(quotes.map((quote) => [buildQuoteKey({ symbol: quote.symbol, exchange: "NASDAQ" }), ready(quote)]));
  const [nxxt, slxn] = createRows(overlayMarketMoverQuotes(rows, entries));
  expect(nxxt).toMatchObject({ name: "NextNRG, Inc.", price: 1.7, changePercent: 811.53, volume: 150_571_444 });
  expect(nxxt!.volumeRatio).toBeCloseTo(18.29, 2);
  expect(slxn).toMatchObject({ name: "Silexion Therapeutics Corp", price: 3.23, volume: 294_106, extended: null });
  expect(slxn!.changePercent).toBeCloseTo(23.58, 2);
  expect(slxn!.volumeRatio).toBeCloseTo(4.8, 1);

  // Once the session opens, the quote's move and volume are the day's.
  const open = { ...quotes[0]!, marketState: "REGULAR", price: 1.9, change: 0.2, changePercent: 11.76, previousClose: 1.7, volume: 4_000_000 } as Quote;
  const [live] = overlayMarketMoverQuotes(rows, new Map([[buildQuoteKey({ symbol: "NXXT", exchange: "NASDAQ" }), ready(open)]]));
  expect(live).toMatchObject({ price: 1.9, changePercent: 11.76, volume: 4_000_000 });
  expect(live).not.toHaveProperty("closedSession");
});

/** A Gainers, Losers or Most Active row as Gloom Cloud sends it: the live print it is ranked by, and its quote's sessions. */
function cloudMoverItem(quote: Quote): CloudMarketScreenerItem {
  const { symbol, price, change, changePercent, previousClose, currency, lastUpdated } = quote;
  return {
    rank: 0, symbol, name: symbol, price, change, changePercent, previousClose, volume: 2_000_000, currency,
    exchange: "NASDAQ", lastUpdated, dataSource: "live", ...moverSessionPayload(quote),
  };
}

/** MOST's `list` from a Pro account's Cloud rows. */
async function cloudList(list: "gainers" | "losers" | "actives", quotes: Quote[], basis?: MoverRankBasis) {
  const headless = createMarketMoversHeadless({
    load: (_args, tab, provider) => loadMarketMoverTab(tab, provider, basis ? { basis } : undefined, {
      fetchPreferred: (category, count) => fetchPreferredMarketMovers(category, count, { metadataWaitMs: 0 }, {
        isCloudEligible: () => true,
        fetchCloud: async (category) => ({ status: "success", data: { providerId: "gloomberb-cloud", category, asOf: "2026-10-10T20:00:00Z", items: quotes.map(cloudMoverItem) } }),
        fetchMarket: async () => ({ data: [], stale: false }),
      }),
      fetchTrending: async () => { throw new Error("unused"); },
    }),
    loadSession: async () => { throw new Error("unused"); },
  });
  const listArgs = { ...args, options: { list } };
  const result = await headless.load(listArgs, { marketData: createTestDataProvider({}) } as never);
  setCliColorEnabledOverride(false);
  return { rows: result.rows, text: renderHeadlessPaneText(headless, result, listArgs, "MOST") };
}

test("Gainers, Losers and Most Active read each row's regular session from the sessions the server sends, as trending does", async () => {
  for (const state of ["weekend", "afterHours", "preMarket"] as const) {
    const quote = sessionQuotes()[state];
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    const { rows, text } = await cloudList("actives", [quote]);
    expect(rows[0]).toMatchObject({
      symbol: "XLK", rank: 1, price: headline.price, change: headline.change, changePercent: headline.changePercent,
      extendedSession: extended.session, extendedPrice: extended.price, extendedChangePercent: extended.changePercent,
    });
    expect(rows[0]).not.toHaveProperty("sessions");
    expect(text.split("\n").find((line) => line.includes(" XLK "))).toMatch(state === "preMarket"
      ? /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/
      : /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/);
  }
  const open = await cloudList("actives", [sessionQuotes().regular]);
  expect(open.rows[0]).toMatchObject({ price: 199.1, changePercent: 0.6674, extendedSession: null });
  expect(open.text).not.toMatch(/After Hours|Pre-Market/);

  // A server that sends no sessions leaves the row as it came.
  const { marketState: _state, regularClose: _close, ...bare } = sessionQuotes().weekend;
  expect((await cloudList("actives", [bare as Quote])).rows[0]).toMatchObject({ price: 198.8, changePercent: 0.5157, extendedSession: null });
});

test("after the close a list ranks by the regular-session move it shows, or by the extended move when asked", async () => {
  // Saturday: AAA closed -8% and printed -10% after hours, BBB closed -9% and printed -8.8%; the live print ranks AAA first.
  const closed = (symbol: string, close: number, last: number) => ({
    symbol, currency: "USD", price: last, change: last - 50, changePercent: (last / 50 - 1) * 100, previousClose: 50,
    regularClose: close, regularCloseSessionDate: "2026-10-09", regularChange: close - 50, regularChangePercent: (close / 50 - 1) * 100,
    changeSessionDate: "2026-10-09", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:58:00Z"),
  }) as Quote;
  const quotes = [closed("AAA", 46, 45), closed("BBB", 45.5, 45.6)];
  const regular = await cloudList("losers", quotes);
  expect(regular.rows.map((row) => [row.symbol, row.rank, Number(Number(row.changePercent).toFixed(2)), row.extendedPrice])).toEqual([
    ["BBB", 1, -9, 45.6],
    ["AAA", 2, -8, 45],
  ]);
  expect(regular.text).toContain("Ranked by the regular-session move.");
  // After hours BBB rose from its close, so it is no after-hours loser.
  const extended = await cloudList("losers", quotes, "extended");
  expect(extended.rows.map((row) => [row.symbol, Number(Number(row.extendedChangePercent).toFixed(2))])).toEqual([["AAA", -2.17]]);
  expect(extended.text).toContain("Ranked by the after-hours move.");
});
