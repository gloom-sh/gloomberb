import { afterEach, expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../market-data/market/status";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { loadMarketMoverTab } from "./client";
import { createMarketMoversHeadless } from "./headless";
import { overlayMarketMoverQuotes, screenerQuoteFromQuote, type MoverQuote } from "./model";
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
      fetchTrending: async () => [{ symbol: "XLK" }, { symbol: "AAPL" }],
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
