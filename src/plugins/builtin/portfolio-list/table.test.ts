import { expect, test } from "bun:test";
import { DEFAULT_PORTFOLIO_COLUMN_IDS, type ColumnConfig } from "../../../types/config";
import { resolveVisibleColumns } from "./settings";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { bookCurrencyColumn, companyDataSettled, fitPortfolioColumns } from "./table";

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

  // 112 cells (900 px on the desktop): the valuation columns, the cost, the sparkline and the quote time go; MKT VAL, DAY, P&L and P&L% stay whole.
  const narrow = ids(fitPortfolioColumns(book, [row(true)], 112));
  expect(narrow).toEqual(["ticker", "price", "currency", "change_pct", "shares", "avg_cost", "mkt_value", "day_pnl", "pnl", "pnl_pct"]);
  // With room for it, the quote time stays.
  expect(ids(fitPortfolioColumns(book, [row(true)], 126))).toContain("as_of");
  // Wide enough, nothing goes; a watchlist has no value to make room for and keeps its valuation columns.
  expect(ids(fitPortfolioColumns(book, [row(true)], 180))).toEqual(ids(book));
  const watchlist = resolveVisibleColumns([...DEFAULT_PORTFOLIO_COLUMN_IDS], false);
  expect(ids(fitPortfolioColumns(watchlist, [row(true)], 40))).toEqual(ids(watchlist));
});

test("a company column hides only once every row's company data has answered, and a row added after never brings it back for a moment", () => {
  const quoted = (instrumentType?: string) => createTestFinancials({ quote: createTestQuote({ ...(instrumentType ? { instrumentType } : {}) }) });
  // A future or a currency has no company figures to wait for; a stock, a fund or a listing of no stated type waits for its snapshot's answer.
  expect(companyDataSettled(quoted("FUTURE"), false)).toBe(true);
  for (const type of ["EQUITY", "ETF", undefined]) {
    expect(companyDataSettled(quoted(type), false)).toBe(false);
    expect(companyDataSettled(quoted(type), true)).toBe(true);
  }
  expect(companyDataSettled(createTestFinancials(), true)).toBe(false);

  const hidden = new Set(book.filter((column) => !ids(fitPortfolioColumns(book, [row(false)], undefined)).includes(column.id)).map((column) => column.id));
  expect(hidden.has("market_cap")).toBe(true);
  // A row just added has not answered: MCAP stays hidden rather than flashing back until it does.
  expect(ids(fitPortfolioColumns(book, [row(false), row(false, false)], undefined, hidden))).not.toContain("market_cap");
  // Once it answers with a figure, the column comes back; a settled row with one brings it back at once too.
  expect(ids(fitPortfolioColumns(book, [row(false), row(true)], undefined, hidden))).toContain("market_cap");
  expect(ids(fitPortfolioColumns(book, [row(true), row(false, false)], undefined, hidden))).toContain("market_cap");
});

test("a column in the book's currency names it as the CLI does, whatever the rows' prices are in", () => {
  const cap = book.find((column) => column.id === "market_cap")!;
  expect(bookCurrencyColumn(cap, "TRY")).toMatchObject({ label: `${cap.label} (TRY)`, width: Math.max(cap.width, `${cap.label} (TRY)`.length) });
  // A Canadian book: its value is in CAD whether the holding is quoted in USD or in CAD, and the header is wide enough to say so.
  expect(bookCurrencyColumn({ id: "mkt_value", label: "MKT VAL", width: 10, align: "right" }, "CAD")).toMatchObject({ label: "MKT VAL (CAD)", width: 13 });
});
