import { useCallback, useMemo, useRef } from "react";
import { QUICK_ADD_KEY } from "./quick-add";
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
import { tickerDisplayName } from "./column-values";
import { displayWidth } from "../../../utils/format";
import { portfolioPnlLabel } from "../../../portfolio/position-metrics";
import { PORTFOLIO_ROW_MENU_KEYS } from "./row-actions";

export type { QuoteFlashDirection };

/** The market-state dot and the space after it, before each symbol in the Ticker column. */
const TICKER_DOT_WIDTH = 2;
/** The widest the Ticker column grows for its symbols; an option contract longer than that still clips. */
const MAX_TICKER_COLUMN_WIDTH = 12;

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
  flashSymbols,
  onRootKeyDown,
  onVisibleRangeChange,
  visibleRangeBuffer,
  resetScrollKey,
  onRowActivate,
  onAddTicker,
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
  flashSymbols: Map<string, QuoteFlashDirection>;
  onRootKeyDown?: (event: DataTableKeyEvent) => boolean | void;
  onVisibleRangeChange?: (range: TickerListVisibleRange) => void;
  visibleRangeBuffer?: number;
  resetScrollKey?: unknown;
  onRowActivate?: (ticker: TickerRecord) => void;
  /** Opens the add row; the empty table offers it as a button. */
  onAddTicker?: () => void;
  /** Opens PERP on a row's stock perpetual: its PERP% and FUND 8H cells link to it. */
  onOpenPerpetual?: (marketId: string) => void;
  rootHeight?: number;
}) {
  const cellCacheRef = useRef(createRowValueCache<string, ReturnType<typeof getColumnValue> & TickerTableCell>(5000));
  const openPerpetualRef = useRef(onOpenPerpetual);
  openPerpetualRef.current = onOpenPerpetual;
  const sparklineVisible = columns.some((column) => column.id === PRICE_SPARKLINE_COLUMN_ID);
  const tableFinancialsMap = useLiveSparklineFinancials(financialsMap, sortedTickers, sparklineVisible);
  const resolveCell = useCallback(
    (column: ColumnConfig, ticker: TickerRecord, financials: TickerFinancials | undefined) => {
      const key = `${ticker.metadata.ticker}:${column.id}`;
      const version = buildCellVersion(column, ticker, financials, columnContext);
      return cellCacheRef.current.get(key, version, () => {
        const cell = getColumnValue(column, ticker, financials, columnContext);
        const marketId = PERPETUAL_COLUMN_IDS.has(column.id) ? columnContext.perpetuals?.get(ticker.metadata.ticker)?.marketId : undefined;
        return marketId ? { ...cell, onPress: () => openPerpetualRef.current?.(marketId) } : cell;
      });
    },
    [columnContext],
  );
  const pnlColumn = columns.find((column) => column.id === "pnl" || column.id === "pnl_pct");
  // Reads the same cached P&L cells the rows show; only changed rows recompute.
  const pnlLabel = pnlColumn ? portfolioPnlLabel(sortedTickers.map((ticker) =>
    resolveCell(pnlColumn.id === "pnl" ? pnlColumn : { ...pnlColumn, id: "pnl" }, ticker, tableFinancialsMap.get(ticker.metadata.ticker)).pnlBasis ?? "unavailable")) : "P&L";
  const hasNonShareQuantity = useMemo(() => sortedTickers.some(ticker => ticker.metadata.positions.some(position =>
    (!columnContext.activeTab || position.portfolio === columnContext.activeTab) && position.shares !== 0 && (position.priceBasis === "percent-of-par" || ticker.metadata.assetCategory?.toUpperCase() === "BOND"))),
  [columnContext.activeTab, sortedTickers]);
  // The Ticker column grows to its longest symbol, so ETH-USD shows whole beside its market-state dot.
  const tickerWidth = useMemo(() => Math.min(MAX_TICKER_COLUMN_WIDTH, sortedTickers.reduce(
    (widest, ticker) => Math.max(widest, TICKER_DOT_WIDTH + displayWidth(tickerDisplayName(ticker))),
    0,
  )), [sortedTickers]);
  const displayColumns = useMemo(() => columns.map((column) => column.id === "shares" && hasNonShareQuantity ? { ...column, label: "QTY" }
    : column.id === "ticker" && tickerWidth > column.width ? { ...column, width: tickerWidth }
    : pnlLabel !== "P&L" && (column.id === "pnl" || column.id === "pnl_pct") ? {
    ...column,
    label: column.id === "pnl_pct" ? pnlLabel.replace("P&L", "%") : pnlLabel,
  } : column), [columns, hasNonShareQuantity, pnlLabel, tickerWidth]);
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
      onVisibleRangeChange={onVisibleRangeChange}
      visibleRangeBuffer={visibleRangeBuffer}
      resetScrollKey={resetScrollKey}
      onRowActivate={onRowActivate}
      rowMenuAccelerators={PORTFOLIO_ROW_MENU_KEYS}
      onAddTicker={onAddTicker}
      addTickerShortcut={onAddTicker ? QUICK_ADD_KEY : undefined}
      rootHeight={rootHeight}
    />
  );
}
