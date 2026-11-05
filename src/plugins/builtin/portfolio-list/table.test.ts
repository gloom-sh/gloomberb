import { expect, test } from "bun:test";
import { DEFAULT_PORTFOLIO_COLUMN_IDS, type ColumnConfig } from "../../../types/config";
import { resolveVisibleColumns } from "./settings";
import { fitPortfolioColumns } from "./table";

const book = resolveVisibleColumns([...DEFAULT_PORTFOLIO_COLUMN_IDS], true, { otherCurrencies: true });
const ids = (columns: readonly ColumnConfig[]) => columns.map((column) => column.id);
/** A row whose company columns are dashes (a future), or that has figures (a stock). */
const row = (company: boolean, settled = true) => ({ cell: (column: ColumnConfig) => (company ? `${column.id} 1` : "—"), settled });

test("a book of futures hides the company columns once its data is in; a narrow book keeps value and P&L before valuation", () => {
  // Every row a future: MCAP, P/E and FWD P/E are dashes all down, so they go, but not while a row could still fill in.
  expect(ids(fitPortfolioColumns(book, [row(false), row(false)], undefined))).not.toContain("market_cap");
  expect(ids(fitPortfolioColumns(book, [row(false), row(false, false)], undefined))).toEqual(ids(book));
  expect(ids(fitPortfolioColumns(book, [row(false), row(true)], undefined))).toEqual(ids(book));
  expect(ids(fitPortfolioColumns(book, [], undefined))).toEqual(ids(book));

  // 112 cells (900 px on the desktop): the valuation columns, the cost and the sparkline go; MKT VAL, DAY and P&L stay.
  const narrow = ids(fitPortfolioColumns(book, [row(true)], 112));
  expect(narrow).toEqual(["ticker", "price", "currency", "change_pct", "as_of", "shares", "avg_cost", "mkt_value", "day_pnl", "pnl", "pnl_pct"]);
  // Wide enough, nothing goes; a watchlist has no value to make room for and keeps its valuation columns.
  expect(ids(fitPortfolioColumns(book, [row(true)], 180))).toEqual(ids(book));
  const watchlist = resolveVisibleColumns([...DEFAULT_PORTFOLIO_COLUMN_IDS], false);
  expect(ids(fitPortfolioColumns(watchlist, [row(true)], 40))).toEqual(ids(watchlist));
});
