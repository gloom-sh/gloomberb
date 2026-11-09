import { useCallback, useMemo, useRef } from "react";
import {
  TickerListTableView,
  type DataTableKeyEvent,
  type TickerListVisibleRange,
} from "../../../components";
import { useDataTableSortMenu } from "../../../components/data-table/sort-menu";
import { followLiveSparklinePrice } from "../../../components/price-sparkline/model";
import { PRICE_SPARKLINE_COLUMN_ID } from "../../../components/price-sparkline/view";
import type { QuoteFlashDirection } from "../../../components/quote-flash";
import type { TickerTableCell, TickerTableSummaryRow } from "../../../components/ticker/list-table-view";
import { createRowValueCache } from "../../../components/ui/row-value-cache";
import type { ColumnConfig } from "../../../types/config";
import type { PricePoint, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { objectVersion } from "../../../utils/object-version";
import { columnContextVersion, PERPETUAL_COLUMN_IDS } from "./cell-version";
import { getColumnValue, type ColumnContext } from "./metrics";
import { periodPnlFigure, tickerDisplayName } from "../../../portfolio/column-values";
import { listedSymbol } from "../../../portfolio/listed-symbol";
import { displayWidth } from "../../../utils/format";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { sinceLastSeenTint, type SinceLastSeenRecap } from "./since-last-seen";
import { portfolioPnlLabel } from "../../../portfolio/position-metrics";
import { PORTFOLIO_ROW_MENU_KEYS } from "./row-actions";
import { isFuturesTicker } from "../../../portfolio/futures-positions";
import { resolveCurrencyUnit } from "../../../utils/currency-units";

export type { QuoteFlashDirection };

/** Columns whose amounts read in the book's currency, whatever the listing's: market cap, cost, value, trade value, day and P&L. */
const BOOK_CURRENCY_COLUMN_IDS: ReadonlySet<string> = new Set(["market_cap", "cost_basis", "mkt_value", "trade_value", "day_pnl", "pnl"]);

/**
 * A column whose amounts read in the book's currency, under a header that
 * names it as the CLI does when a row's price is in another (`MKT CAP (TRY)`
 * beside BRK.B's dollars, `MKT VAL (CAD)` beside NBIS's), wide enough for it; as it was when
 * every price is in that currency, pence in pounds included.
 */
export function bookCurrencyColumn(column: ColumnConfig, currency: string, listed: ReadonlyArray<string | null | undefined>): ColumnConfig {
  if (!listed.some((code) => !!code && resolveCurrencyUnit(code).currency !== currency)) return column;
  const label = `${column.label} (${currency})`;
  return { ...column, label, width: Math.max(column.width, displayWidth(label)) };
}

/** The market-state dot and the space after it, before each symbol in the Ticker column. */
const TICKER_DOT_WIDTH = 2;
/**
 * The widest the Ticker column grows for its symbols: a perpetual as its venue writes it (`xyz:BRENTOIL`) and an
 * option as its terms (`NVDA C $1250 Dec'26`) fit, so only a list holding options is given the width.
 */
const MAX_TICKER_COLUMN_WIDTH = 22;
/** WEIGHT's header on a book that holds a short: its weights are shares of gross exposure. As wide as WEIGHT. */
const GROSS_WEIGHT_LABEL = "GROSS WT";
/** P&L%'s header over a period: each position's P&L as a share of the book at the start. */
const CONTRIBUTION_LABEL = "CONTRIB";

/** The widest a futures quantity grows the QTY column: `-12,000 × 5,000 bushels` fits. */
const MAX_QUANTITY_COLUMN_WIDTH = 24;

/**
 * Columns that describe the company. A dash in every row means none of them
 * has one (a book of futures, funds or currencies), so the column goes.
 */
const COMPANY_COLUMN_IDS: ReadonlySet<string> = new Set([
  "market_cap", "pe", "forward_pe", "dividend_yield", "target", "target_pct", "rating", "ex_div", "next_earn", "sector", "industry",
]);
/**
 * What a narrow book gives up, in order, so its value and P&L stay on screen:
 * the valuation columns, then the cost (quantity times average cost), the
 * month's sparkline, and last each quote's time, which the footer's clock
 * still gives.
 */
const NARROW_BOOK_DROP_ORDER = ["forward_pe", "pe", "dividend_yield", "market_cap", "cost_basis", PRICE_SPARKLINE_COLUMN_ID, "as_of"];
/** Columns of a held position: a list that shows one is a book, whose value outranks its valuation. */
const POSITION_COLUMN_IDS: ReadonlySet<string> = new Set(["shares", "avg_cost", "cost_basis", "mkt_value", "weight", "day_pnl", "pnl", "pnl_pct"]);

const isEmptyCell = (text: string) => /^[\s—–-]*$/.test(text);

/** Listings no company figures exist for: their quote is all a company column waits on. */
const NO_COMPANY_DATA_TYPES: ReadonlySet<string> = new Set(["FUTURE", "FUTURES", "FUT", "CURRENCY", "CRYPTO", "CRYPTOCURRENCY", "INDEX", "OPTION", "BOND", "PERP"]);

/**
 * Whether a row's company columns say all they will: its quote is in, and so
 * are its fundamentals, or its snapshot answered without them (`answered`).
 * A stock, a fund or a listing of no stated type waits for that answer, as
 * its dash may still fill in; a future, a currency or an index does not.
 */
export function companyDataSettled(financials: TickerFinancials | undefined, answered: boolean): boolean {
  const quote = financials?.quote;
  if (!quote) return false;
  if (financials.fundamentals || answered) return true;
  const type = quote.instrumentType?.trim().toUpperCase();
  return !!type && NO_COMPANY_DATA_TYPES.has(type);
}

/**
 * The columns a book shows: a company column no row has a figure for is
 * hidden once every row has settled, and a narrow book gives up its
 * valuation columns before its value and P&L run off the edge. A column
 * already hidden (`hidden`) stays hidden while a row added since settles,
 * unless a settled row has a figure for it, so adding a row never brings it
 * back for a moment.
 */
export function fitPortfolioColumns(
  columns: readonly ColumnConfig[],
  rows: readonly { cell: (column: ColumnConfig) => string; settled: boolean }[],
  width: number | undefined,
  hidden: ReadonlySet<string> = new Set(),
): ColumnConfig[] {
  const settled = rows.length > 0 && rows.every((row) => row.settled);
  const figured = (column: ColumnConfig) => rows.some((row) => row.settled && !isEmptyCell(row.cell(column)));
  const shown = columns.filter((column) => !COMPANY_COLUMN_IDS.has(column.id)
    || (settled ? figured(column) : !hidden.has(column.id) || figured(column)));
  if (width == null || !shown.some((column) => POSITION_COLUMN_IDS.has(column.id))) return shown;
  return dropColumnsToFit(shown, width - 1, NARROW_BOOK_DROP_ORDER);
}

/** A cell recomputes only when its row's records or a context input it reads change. */
function buildCellVersion(
  column: ColumnConfig,
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  context: ColumnContext,
): string {
  return `${column.id}|${objectVersion(ticker)}|${objectVersion(financials)}|${columnContextVersion(column.id, context)}`;
}

interface LiveSparklineEntry {
  source: TickerFinancials;
  history: PricePoint[];
  financials: TickerFinancials;
}

/**
 * The rows' financials with each sparkline closed by its live price. A row's
 * entry is rebuilt only when its financials change, and keeps its series when
 * the move is too small to draw.
 */
function useLiveSparklineFinancials(
  financialsMap: Map<string, TickerFinancials>,
  tickers: TickerRecord[],
  enabled: boolean,
): Map<string, TickerFinancials> {
  const entriesRef = useRef(new Map<string, LiveSparklineEntry>());
  return useMemo(() => {
    if (!enabled) {
      entriesRef.current.clear();
      return financialsMap;
    }
    const entries = entriesRef.current;
    const result = new Map(financialsMap);
    const next = new Map<string, LiveSparklineEntry>();
    for (const ticker of tickers) {
      const symbol = ticker.metadata.ticker;
      const source = financialsMap.get(symbol);
      if (!source) continue;
      const cached = entries.get(symbol);
      let entry = cached?.source === source ? cached : undefined;
      if (!entry) {
        const history = followLiveSparklinePrice(source.priceHistory, source.quote, {
          assetCategory: source.quote?.instrumentType ?? ticker.metadata.assetCategory,
          previous: cached?.source.priceHistory === source.priceHistory ? cached.history : undefined,
        });
        entry = {
          source,
          history,
          financials: history === source.priceHistory ? source : { ...source, priceHistory: history },
        };
      }
      next.set(symbol, entry);
      result.set(symbol, entry.financials);
    }
    entriesRef.current = next;
    return result;
  }, [enabled, financialsMap, tickers]);
}

export function PortfolioTickerTable({
  columns,
  focused,
  sortColumnId,
  sortDirection,
  onHeaderClick,
  sortedTickers,
  cursorSymbol,
  setCursorSymbol,
  onCursorChange,
  financialsMap,
  columnContext,
  futuresFrontNotes,
  flashSymbols,
  sinceLastSeen,
  onRootKeyDown,
  onTableMouseDown,
  onVisibleRangeChange,
  visibleRangeBuffer,
  resetScrollKey,
  onRowActivate,
  addTickerShortcut,
  onOpenPerpetual,
  rootHeight,
  width,
  answeredSnapshots,
  exportName,
}: {
  columns: ColumnConfig[];
  focused?: boolean;
  sortColumnId: string | null;
  sortDirection: "asc" | "desc";
  onHeaderClick: (columnId: string) => void;
  sortedTickers: TickerRecord[];
  cursorSymbol: string | null;
  setCursorSymbol: (symbol: string) => void;
  onCursorChange?: (ticker: TickerRecord, index: number) => void;
  financialsMap: Map<string, TickerFinancials>;
  columnContext: ColumnContext;
  futuresFrontNotes?: ReadonlyMap<string, string>;
  flashSymbols: Map<string, QuoteFlashDirection>;
  /** For a few seconds after coming back to the pane, LAST is tinted by each row's move since the user left. */
  sinceLastSeen?: SinceLastSeenRecap | null;
  onRootKeyDown?: (event: DataTableKeyEvent) => boolean | void;
  /** Any press in the table: a row, a cell, the header or the empty body. */
  onTableMouseDown?: () => void;
  onVisibleRangeChange?: (range: TickerListVisibleRange) => void;
  visibleRangeBuffer?: number;
  resetScrollKey?: unknown;
  onRowActivate?: (ticker: TickerRecord) => void;
  /** The key of the add row, which the empty table names. The pane shows the row itself, once. */
  addTickerShortcut?: string;
  /** Opens PERP on a row's stock perpetual: its PERP% and FUND 8H cells link to it. */
  onOpenPerpetual?: (marketId: string) => void;
  rootHeight?: number;
  /** The pane's width in cells: a narrow book gives up its valuation columns first. */
  width?: number;
  /** Rows whose financial snapshot answered: until then a company column's dash may still fill in. */
  answeredSnapshots?: ReadonlySet<string>;
  /** The list's name, which names its exported file. */
  exportName?: string;
}) {
  const cellCacheRef = useRef(createRowValueCache<string, ReturnType<typeof getColumnValue> & TickerTableCell>(5000));
  const openPerpetualRef = useRef(onOpenPerpetual);
  openPerpetualRef.current = onOpenPerpetual;
  const sparklineVisible = columns.some((column) => column.id === PRICE_SPARKLINE_COLUMN_ID);
  const tableFinancialsMap = useLiveSparklineFinancials(financialsMap, sortedTickers, sparklineVisible);
  const noteColumnId = columns.some((column) => column.id === "name") ? "name" : "ticker";
  const hasFrontReference = useMemo(() => sortedTickers.some((ticker) => columnContext.futuresTerms?.get(ticker.metadata.ticker)?.front),
    [columnContext.futuresTerms, sortedTickers]);
  const resolveCell = useCallback(
    (column: ColumnConfig, ticker: TickerRecord, financials: TickerFinancials | undefined) => {
      const key = `${ticker.metadata.ticker}:${column.id}`;
      const version = buildCellVersion(column, ticker, financials, columnContext);
      const cached = cellCacheRef.current.get(key, version, () => {
        const cell = getColumnValue(column, ticker, financials, columnContext);
        const marketId = PERPETUAL_COLUMN_IDS.has(column.id) ? columnContext.perpetuals?.get(ticker.metadata.ticker)?.marketId : undefined;
        return marketId ? { ...cell, onPress: () => openPerpetualRef.current?.(marketId) } : cell;
      });
      const note = column.id === noteColumnId ? futuresFrontNotes?.get(ticker.metadata.ticker) : undefined;
      const cell = note ? { ...cached, note } : cached;
      // LAST keeps its price: a move since the user last looked only tints the cell.
      if (column.id !== "price" || !sinceLastSeen) return cell;
      const move = sinceLastSeen.moves.get(ticker.metadata.ticker);
      return move == null ? cell : { ...cell, backgroundColor: sinceLastSeenTint(move, sinceLastSeen.fading) };
    },
    [columnContext, futuresFrontNotes, noteColumnId, sinceLastSeen],
  );
  const pnlColumn = columns.find((column) => column.id === "pnl" || column.id === "pnl_pct");
  const period = !!columnContext.periodPnl;
  // Reads the same cached P&L cells the rows show; only changed rows recompute. A period's P&L is one basis: the closes.
  const pnlLabel = pnlColumn && !period ? portfolioPnlLabel(sortedTickers.map((ticker) =>
    resolveCell(pnlColumn.id === "pnl" ? pnlColumn : { ...pnlColumn, id: "pnl" }, ticker, tableFinancialsMap.get(ticker.metadata.ticker)).pnlBasis ?? "unavailable")) : "P&L";
  // Face amounts and futures contracts are not shares.
  const heldFutures = useMemo(() => sortedTickers.filter((ticker) => isFuturesTicker(ticker) && ticker.metadata.positions.some((position) =>
    (!columnContext.activeTab || position.portfolio === columnContext.activeTab) && position.shares !== 0)),
  [columnContext.activeTab, sortedTickers]);
  const hasNonShareQuantity = useMemo(() => heldFutures.length > 0 || sortedTickers.some(ticker => ticker.metadata.positions.some(position =>
    (!columnContext.activeTab || position.portfolio === columnContext.activeTab) && position.shares !== 0 && (position.priceBasis === "percent-of-par" || ticker.metadata.assetCategory?.toUpperCase() === "BOND"))),
  [columnContext.activeTab, heldFutures, sortedTickers]);
  // A future's quantity says what a contract is (-1,000 × 100 oz), so the column grows to the longest.
  const sharesColumn = columns.find((column) => column.id === "shares");
  const sharesWidth = sharesColumn ? Math.min(MAX_QUANTITY_COLUMN_WIDTH, heldFutures.reduce(
    (widest, ticker) => Math.max(widest, displayWidth(resolveCell(sharesColumn, ticker, tableFinancialsMap.get(ticker.metadata.ticker)).text)),
    sharesColumn.width,
  )) : 0;
  // The Ticker column grows to its longest symbol, so ETH-USD and BA:LSE show whole beside their market-state dot.
  const tickerWidth = useMemo(() => Math.min(MAX_TICKER_COLUMN_WIDTH, sortedTickers.reduce(
    (widest, ticker) => Math.max(widest, TICKER_DOT_WIDTH + displayWidth(listedSymbol(ticker, tickerDisplayName(ticker), columnContext.homeMarket))),
    0,
  )), [columnContext.homeMarket, sortedTickers]);
  // A book that holds a short weighs its positions against gross exposure, and the header says so.
  const grossWeights = columnContext.portfolioWeightBasis === "gross";
  // Market caps, values and P&L read in the book's currency: beside a price in another, the header names it (MKT VAL (CAD) by a USD price).
  const capCurrency = columnContext.baseCurrency;
  // One code, the first other currency or none, so a quote's tick does not rebuild the columns.
  const otherListedCurrency = useMemo(() => columns.some((column) => BOOK_CURRENCY_COLUMN_IDS.has(column.id))
    ? sortedTickers.map((ticker) => tableFinancialsMap.get(ticker.metadata.ticker)?.quote?.currency ?? ticker.metadata.currency)
      .find((code) => !!code && resolveCurrencyUnit(code).currency !== capCurrency) ?? null
    : null, [capCurrency, columns, sortedTickers, tableFinancialsMap]);
  const sizedColumns = useMemo(() => columns.map((column) => column.id === "shares" && hasNonShareQuantity
    ? { ...column, label: "QTY", ...(sharesWidth > column.width ? { width: sharesWidth } : {}) }
    : column.id === "weight" && grossWeights ? { ...column, label: GROSS_WEIGHT_LABEL }
    : column.id === "ticker" && tickerWidth > column.width ? { ...column, width: tickerWidth }
    : column.id === "pnl_pct" && period ? { ...column, label: CONTRIBUTION_LABEL }
    : pnlLabel !== "P&L" && (column.id === "pnl" || column.id === "pnl_pct") ? {
    ...column,
    label: column.id === "pnl_pct" ? pnlLabel.replace("P&L", "%") : pnlLabel,
  } : column).map((column) => BOOK_CURRENCY_COLUMN_IDS.has(column.id) ? bookCurrencyColumn(column, capCurrency, [otherListedCurrency]) : column)
    .map((column) => hasFrontReference && column.id === noteColumnId ? { ...column, flexGrow: 1 } : column),
  [capCurrency, columns, grossWeights, hasFrontReference, hasNonShareQuantity, noteColumnId, otherListedCurrency, period, pnlLabel, sharesWidth, tickerWidth]);
  // Read again as the rows' data moves, from the cells the rows show; the columns change only when what is hidden does.
  // The company columns hidden last time, per list, stay hidden while a row added since settles.
  const hiddenCompanyRef = useRef<{ list: string | undefined; ids: ReadonlySet<string> }>({ list: undefined, ids: new Set() });
  if (hiddenCompanyRef.current.list !== columnContext.activeTab) hiddenCompanyRef.current = { list: columnContext.activeTab, ids: new Set() };
  const hiddenColumnIds = useMemo(() => {
    const shown = new Set(fitPortfolioColumns(sizedColumns, sortedTickers.map((ticker) => {
      const financials = tableFinancialsMap.get(ticker.metadata.ticker);
      return {
        cell: (column: ColumnConfig) => resolveCell(column, ticker, financials).text,
        settled: companyDataSettled(financials, !!answeredSnapshots?.has(ticker.metadata.ticker)),
      };
    }), width, hiddenCompanyRef.current.ids).map((column) => column.id));
    return sizedColumns.filter((column) => !shown.has(column.id)).map((column) => column.id).join(",");
  }, [answeredSnapshots, resolveCell, sizedColumns, sortedTickers, tableFinancialsMap, width]);
  hiddenCompanyRef.current.ids = new Set(hiddenColumnIds.split(",").filter((id) => COMPANY_COLUMN_IDS.has(id)));
  const displayColumns = useMemo(() => {
    const hidden = new Set(hiddenColumnIds.split(","));
    return hiddenColumnIds ? sizedColumns.filter((column) => !hidden.has(column.id)) : sizedColumns;
  }, [hiddenColumnIds, sizedColumns]);
  // Over a period, the FX line under the rows, so P&L adds up to the header's total as portfolio show --from prints it.
  const periodFx = columnContext.periodPnl?.fx ?? null;
  const summaryRows = useMemo<TickerTableSummaryRow[] | undefined>(() => periodFx ? [{
    id: "period-fx",
    cells: {
      [displayColumns.some((column) => column.id === "ticker") ? "ticker" : displayColumns[0]?.id ?? "ticker"]: { text: `FX (${periodFx.currencies})` },
      pnl: periodPnlFigure(periodFx.pnl, "pnl"),
      pnl_pct: periodPnlFigure(periodFx.contribution, "contribution"),
    },
  }] : undefined, [displayColumns, periodFx]);
  // The table offers "Sort by…" while it has a sort column. A watchlist starts
  // unsorted and a third header click turns sorting off, so the unsorted state
  // needs its own entry until TickerListTableView takes `sortable`.
  useDataTableSortMenu({
    enabled: !!focused && sortColumnId === null,
    columns: displayColumns,
    sortColumnId: null,
    sortDirection,
    onHeaderClick,
  });

  return (
    <TickerListTableView
      focused={focused}
      columns={displayColumns}
      tickers={sortedTickers}
      cursorSymbol={cursorSymbol}
      setCursorSymbol={setCursorSymbol}
      onCursorChange={onCursorChange}
      resolveCell={resolveCell}
      financialsMap={tableFinancialsMap}
      flashSymbols={flashSymbols}
      sortColumnId={sortColumnId}
      sortDirection={sortDirection}
      onHeaderClick={onHeaderClick}
      onRootKeyDown={onRootKeyDown}
      onTableMouseDown={onTableMouseDown}
      onVisibleRangeChange={onVisibleRangeChange}
      visibleRangeBuffer={visibleRangeBuffer}
      resetScrollKey={resetScrollKey}
      onRowActivate={onRowActivate}
      rowMenuAccelerators={PORTFOLIO_ROW_MENU_KEYS}
      addTickerShortcut={addTickerShortcut}
      summaryRows={summaryRows}
      rootHeight={rootHeight}
      exportName={exportName}
    />
  );
}
