import { afterEach, expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { getTableWidth } from "../../../components/ui/table-layout";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../market-data/market/status";
import type { PricePoint, Quote } from "../../../types/financials";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { createSectorsHeadless } from "./headless";
import { getSectorCollection } from "./sector-data";
import { buildSectorColumns, overlayLiveSectorQuote, type SectorRow } from "./sector-model";

afterEach(() => setCliColorEnabledOverride(null));

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: { collection: "sectors" } };
const history: PricePoint[] = [
  { date: new Date("2025-10-09"), close: 150 },
  { date: new Date("2026-09-09"), close: 180 },
  { date: new Date("2026-10-08"), close: 197.78 },
  { date: new Date("2026-10-09"), close: 198.78 },
];

/** BI with every fund quoted as XLK is in `state`. */
async function board(state: keyof ReturnType<typeof sessionQuotes>) {
  const quote = (symbol: string): Quote => sessionQuotes(symbol)[state];
  const marketData = {
    getQuotesBatch: async (targets: Array<{ symbol: string }>) => targets.map((target) => ({ target: { symbol: target.symbol, exchange: "" }, quote: quote(target.symbol) })),
    getQuote: async (symbol: string) => quote(symbol),
    getPriceHistory: async () => history,
  };
  const headless = createSectorsHeadless();
  const result = await headless.load(args, { marketData } as unknown as HeadlessPaneContext);
  setCliColorEnabledOverride(false);
  const text = renderHeadlessPaneText(headless, result, args, "Sector Performance");
  const xlk = result.rows.find((row) => row.etf === "XLK")!;
  return { xlk, text, line: text.split("\n").find((row) => row.includes(" XLK ")) ?? "" };
}

test("BI headlines the regular close and its move, with the extended print in its own column", async () => {
  for (const state of ["weekend", "afterHours", "preMarket"] as const) {
    const quote = sessionQuotes()[state];
    const { xlk, text, line } = await board(state);
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    // Before the open the close and its move are read from the history the returns use.
    expect(xlk).toMatchObject({ price: headline.price, returnAsOfDate: "2026-10-09" });
    expect(xlk.changePercent).toBeCloseTo(headline.changePercent!, 4);
    expect(xlk).toMatchObject({ extendedSession: extended.session, extendedPrice: extended.price });
    expect(xlk.extendedChangePercent).toBeCloseTo(extended.changePercent!, 8);
    // The returns end at the close, not at an extended print.
    expect(xlk.return1M).toBeCloseTo((198.78 / 180 - 1) * 100, 6);
    expect(text).toContain(state === "preMarket" ? "Pre-Market" : "After Hours");
    expect(line).toMatch(state === "preMarket" ? /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/ : /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/);
  }

  const open = await board("regular");
  expect(open.xlk).toMatchObject({ price: 199.1, changePercent: 0.6674, extendedSession: null, extendedPrice: null });
  expect(open.text).not.toMatch(/After Hours|Pre-Market/);
});

test("in the pane a tick after the close moves only the extended column, and a narrow pane drops it before the names", () => {
  const { afterHours, preMarket, regular } = sessionQuotes();
  const row = {
    ...getSectorCollection("sectors").items[0]!, price: 198.78, changePercent: 0.5056, return1M: 10, return1Y: 25,
    currency: "USD", loading: false, returnAsOfDate: "2026-10-09", quoteUpdatedAt: Date.parse("2026-10-09T15:00:00Z"),
  } as SectorRow;

  const tick = overlayLiveSectorQuote(row, { ...afterHours, postMarketPrice: 199.2, postMarketChange: 0.42 });
  expect(tick).toMatchObject({ price: 198.78, changePercent: 0.5056, return1M: 10, extendedSession: "POST", extendedPrice: 199.2 });
  expect(tick.extendedChangePercent).toBeCloseTo((199.2 / 198.78 - 1) * 100, 8);

  // Monday's pre-market leaves Friday's row and moves its extended column, from Friday's close.
  const early = overlayLiveSectorQuote(row, preMarket);
  expect(early).toMatchObject({ price: 198.78, changePercent: 0.5056, extendedSession: "PRE", extendedPrice: 199.5 });

  // In the regular session the row follows the quote, as before.
  expect(overlayLiveSectorQuote(row, regular)).toMatchObject({ price: 199.1, changePercent: 0.6674, extendedSession: null });

  const ids = (width: number) => buildSectorColumns(width, ["POST"]).map((column) => column.id);
  expect(ids(94)).toEqual(["name", "etf", "price", "changePercent", "afterHours", "return1M", "return1Y", "bar"]);
  expect(buildSectorColumns(94, ["POST"]).find((column) => column.id === "afterHours")?.label).toBe("AFTER-HRS");
  // The default floating pane keeps "Consumer Staples" whole: the bar goes first, then the column.
  expect(ids(82)).toEqual(["name", "etf", "price", "changePercent", "afterHours", "return1M", "return1Y"]);
  expect(ids(70)).toEqual(["name", "etf", "price", "changePercent", "return1M", "return1Y"]);
  for (const width of [70, 82, 94]) expect(getTableWidth(buildSectorColumns(width, ["POST"]))).toBeLessThanOrEqual(width);
  expect(buildSectorColumns(82).map((column) => column.id)).toEqual(["name", "etf", "price", "changePercent", "return1M", "return1Y", "bar"]);
});
