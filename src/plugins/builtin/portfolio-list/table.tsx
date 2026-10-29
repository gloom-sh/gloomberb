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
import type { TickerTableCell } from "../../../components/ticker/list-table-view";
import { createRowValueCache } from "../../../components/ui/row-value-cache";
import type { ColumnConfig } from "../../../types/config";
import type { PricePoint, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { objectVersion } from "../../../utils/object-version";
import { columnContextVersion, PERPETUAL_COLUMN_IDS } from "./cell-version";
import { getColumnValue, type ColumnContext } from "./metrics";
import { tickerDisplayName } from "../../../portfolio/column-values";
import { displayWidth } from "../../../utils/format";
import { sinceLastSeenTint, type SinceLastSeenRecap } from "./since-last-seen";
import { portfolioPnlLabel } from "../../../portfolio/position-metrics";
import { PORTFOLIO_ROW_MENU_KEYS } from "./row-actions";
import { isFuturesTicker } from "../../../portfolio/futures-positions";

export type { QuoteFlashDirection };

/** The market-state dot and the space after it, before each symbol in the Ticker column. */
const TICKER_DOT_WIDTH = 2;
/**
 * The widest the Ticker column grows for its symbols: a perpetual as its venue writes it (`xyz:BRENTOIL`) and an
 * option as its terms (`NVDA C $1250 Dec'26`) fit, so only a list holding options is given the width.
 */
const MAX_TICKER_COLUMN_WIDTH = 22;
/** WEIGHT's header on a book that holds a short: its weights are shares of gross exposure. As wide as WEIGHT. */
const GROSS_WEIGHT_LABEL = "GROSS WT";

/** The widest a futures quantity grows the QTY column: `-12,000 × 5,000 bushels` fits. */
const MAX_QUANTITY_COLUMN_WIDTH = 24;

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
  // Reads the same cached P&L cells the rows show; only changed rows recompute.
  const pnlLabel = pnlColumn ? portfolioPnlLabel(sortedTickers.map((ticker) =>
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
  // The Ticker column grows to its longest symbol, so ETH-USD shows whole beside its market-state dot.
  const tickerWidth = useMemo(() => Math.min(MAX_TICKER_COLUMN_WIDTH, sortedTickers.reduce(
    (widest, ticker) => Math.max(widest, TICKER_DOT_WIDTH + displayWidth(tickerDisplayName(ticker))),
    0,
  )), [sortedTickers]);
  // A book that holds a short weighs its positions against gross exposure, and the header says so.
  const grossWeights = columnContext.portfolioWeightBasis === "gross";
  const displayColumns = useMemo(() => columns.map((column) => column.id === "shares" && hasNonShareQuantity
    ? { ...column, label: "QTY", ...(sharesWidth > column.width ? { width: sharesWidth } : {}) }
    : column.id === "weight" && grossWeights ? { ...column, label: GROSS_WEIGHT_LABEL }
    : column.id === "ticker" && tickerWidth > column.width ? { ...column, width: tickerWidth }
    : pnlLabel !== "P&L" && (column.id === "pnl" || column.id === "pnl_pct") ? {
    ...column,
    label: column.id === "pnl_pct" ? pnlLabel.replace("P&L", "%") : pnlLabel,
  } : column).map((column) => hasFrontReference && column.id === noteColumnId ? { ...column, flexGrow: 1 } : column),
  [columns, grossWeights, hasFrontReference, hasNonShareQuantity, noteColumnId, pnlLabel, sharesWidth, tickerWidth]);
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
      rootHeight={rootHeight}
    />
  );
}
