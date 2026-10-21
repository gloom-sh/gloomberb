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
import { overlayMarketMoverQuotes, screenerQuoteFromQuote, type MoverQuote, type MoverRankBasis } from "./model";
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

test("a live quote on a list row keeps the row's place and splits the close from the extended print", () => {
  const ready = (quote: Quote): QueryEntry<Quote> => ({
    phase: "ready", data: quote, lastGoodData: quote, source: "gloomberb-cloud", fetchedAt: null, staleAt: null, error: null, attempts: [],
  });
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
