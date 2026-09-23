import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  TextAttributes,
  tickerContextMenuItems,
  useCommandBarShortcut,
  useContextMenu,
  useRendererHost,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { getSharedRegistry } from "../../plugins/registry";
import { withPluginContextMenuItems } from "../../ui/context-menu";
import type { ContextMenuItem } from "../../types/context-menu";
import type { ColumnConfig } from "../../types/config";
import type { TickerFinancials, PricePoint } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { PRICE_SPARKLINE_COLUMN_ID, PriceSparkline } from "../price-sparkline/view";
import { DataTableView, type DataTableKeyEvent, type DataTableSelection } from "../data-table/view";
import type { QuoteFlashDirection } from "../quote-flash";
import { objectVersion } from "../../utils/object-version";
import { usePaneFooter } from "../layout/pane/footer";

export interface TickerTableCell {
  text: string;
  color?: string;
}

type ResolveTickerTableCell = (
  column: ColumnConfig,
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
) => TickerTableCell;

export interface TickerListVisibleRange {
  start: number;
  end: number;
}

export interface TickerListTableViewProps {
  columns: ColumnConfig[];
  tickers: TickerRecord[];
  cursorSymbol: string | null;
  setCursorSymbol: (symbol: string) => void;
  /**
   * Fires on every cursor move, before the debounced selection commit. Use it
   * for work that should track the cursor rather than the selection, such as
   * warming the rows the cursor is about to land on.
   */
  onCursorChange?: (ticker: TickerRecord, index: number) => void;
  resolveCell: ResolveTickerTableCell;
  financialsMap: Map<string, TickerFinancials>;
  focused?: boolean;
  rootBefore?: ReactNode;
  rootAfter?: ReactNode;
  rootWidth?: number;
  rootHeight?: number;
  rootBackgroundColor?: string;
  headerScrollRef?: RefObject<ScrollBoxRenderable | null>;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll?: () => void;
  onBodyScrollActivity?: () => void;
  keyboardNavigation?: boolean;
  onRootKeyDown?: (event: DataTableKeyEvent) => boolean | void;
  onVisibleRangeChange?: (range: TickerListVisibleRange) => void;
  visibleRangeBuffer?: number;
  resetScrollKey?: unknown;
  flashSymbols?: Map<string, QuoteFlashDirection>;
  sortColumnId?: string | null;
  sortDirection?: "asc" | "desc";
  onHeaderClick?: (columnId: string) => void;
  onRowActivate?: (ticker: TickerRecord) => void;
  /** The pane's own keys for row menu actions, by item id, shown beside them in the pane menu. */
  rowMenuAccelerators?: Readonly<Record<string, string>>;
  emptyTitle?: string;
  emptyHint?: string;
  virtualize?: boolean;
  overscan?: number;
}

const FLASHABLE_QUOTE_COLUMN_IDS = new Set([
  "price",
  "change",
  "change_pct",
  "bid",
  "ask",
  "spread",
  "spread_pct",
  "ext_hours",
  "market_cap",
  "volume",
  "dollar_volume",
  "range_52w",
  "mkt_value",
  "weight",
  "day_pnl",
  "pnl",
  "pnl_pct",
  "mark_delta",
]);

const EMPTY_FLASH_SYMBOLS = new Map<string, QuoteFlashDirection>();

type TableMouseEvent = {
  button?: number;
  detail?: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

function getPriceHistory(financials: TickerFinancials | undefined): PricePoint[] | undefined {
  return financials?.priceHistory;
}

function getTickerKey(ticker: TickerRecord): string {
  return ticker.metadata.ticker;
}

/** What right-clicking the row offers, plugin additions included. */
function tickerRowMenuItems(
  ticker: TickerRecord,
  financials: TickerFinancials | null,
  copyText: (text: string) => Promise<void>,
): ContextMenuItem[] {
  const registry = getSharedRegistry() ?? null;
  return withPluginContextMenuItems(
    { kind: "ticker", symbol: ticker.metadata.ticker, ticker, financials },
    tickerContextMenuItems({ ticker, financials, registry, copyText }),
    registry,
  );
}

/**
 * A ticker's right-click menu, for the keyboard: the pane menu (".", Shift+F10,
 * the Menu key) lists it first while `enabled`. The ticker table registers its
 * cursor row; a surface with a cursor of its own (a treemap) registers that.
 */
export function useTickerRowPaneMenu({
  ticker,
  financials,
  enabled,
  accelerators,
}: {
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  enabled: boolean;
  /** The pane's own keys for these actions, by item id, shown beside them. */
  accelerators?: Readonly<Record<string, string>>;
}): void {
  const renderer = useRendererHost();
  const registrationId = `ticker-row-menu:${useId()}`;
  usePaneFooter(registrationId, () => {
    if (!enabled || !ticker) return null;
    const items = tickerRowMenuItems(ticker, financials, renderer.copyText.bind(renderer));
    return {
      order: -1,
      menu: accelerators
        ? items.map((item) => (item.type === "divider" || item.type === "role" || !accelerators[item.id]
          ? item
          : { ...item, accelerator: accelerators[item.id] }))
        : items,
    };
  }, [accelerators, enabled, financials, renderer, ticker]);
}

export function TickerListTableView({
  focused = false,
  rootBefore,
  rootAfter,
  rootWidth,
  rootHeight,
  rootBackgroundColor,
  headerScrollRef,
  scrollRef,
  syncHeaderScroll,
  onBodyScrollActivity,
  keyboardNavigation = true,
  onRootKeyDown,
  onVisibleRangeChange,
  visibleRangeBuffer = 0,
  resetScrollKey,
  columns,
  tickers,
  cursorSymbol,
  setCursorSymbol,
  onCursorChange,
  resolveCell,
  financialsMap,
  flashSymbols,
  sortColumnId,
  sortDirection = "asc",
  onHeaderClick,
  onRowActivate,
  rowMenuAccelerators,
  emptyTitle = t("No tickers."),
  emptyHint,
  virtualize = true,
  overscan = 4,
}: TickerListTableViewProps) {
  const commandBarShortcut = useCommandBarShortcut();
  const resolvedEmptyHint = emptyHint ?? tf("Press {shortcut} to add one.", { shortcut: commandBarShortcut });
  const renderer = useRendererHost();
  const { showContextMenu } = useContextMenu();
  const { nativeContextMenu } = useUiCapabilities();
  const internalHeaderScrollRef = useRef<ScrollBoxRenderable>(null);
  const internalScrollRef = useRef<ScrollBoxRenderable>(null);
  const effectiveHeaderScrollRef = headerScrollRef ?? internalHeaderScrollRef;
  const effectiveScrollRef = scrollRef ?? internalScrollRef;
  const safeFlashSymbols = flashSymbols ?? EMPTY_FLASH_SYMBOLS;
  const selectedIndex = useMemo(
    () => tickers.findIndex((ticker) => ticker.metadata.ticker === cursorSymbol),
    [cursorSymbol, tickers],
  );
  const lastScrollCursorSymbolRef = useRef<string | null | undefined>(undefined);

  const emitVisibleRange = useCallback(() => {
    if (!onVisibleRangeChange) return;
    const scrollBox = effectiveScrollRef.current;
    if (!scrollBox?.viewport) return;
    const start = Math.max(0, scrollBox.scrollTop - visibleRangeBuffer);
    const end = Math.min(
      tickers.length,
      scrollBox.scrollTop + scrollBox.viewport.height + visibleRangeBuffer,
    );
    onVisibleRangeChange({ start, end });
  }, [effectiveScrollRef, onVisibleRangeChange, tickers.length, visibleRangeBuffer]);

  const handleBodyScrollActivity = useCallback(() => {
    onBodyScrollActivity?.();
    emitVisibleRange();
  }, [emitVisibleRange, onBodyScrollActivity]);

  useEffect(() => {
    const shouldScrollToCursor = lastScrollCursorSymbolRef.current !== cursorSymbol;
    lastScrollCursorSymbolRef.current = cursorSymbol;
    if (shouldScrollToCursor && selectedIndex >= 0) queueMicrotask(emitVisibleRange);
  }, [cursorSymbol, emitVisibleRange, selectedIndex]);

  useEffect(() => {
    queueMicrotask(emitVisibleRange);
  }, [emitVisibleRange]);

  // A quote tick replaces the financials map and the flash set. The cell
  // renderer reads both through refs so it keeps one identity, and each row's
  // version carries its own records and flash, so one symbol's tick redraws
  // one row. A new `resolveCell` (another column context: FX, weights, the
  // AGE clock) still redraws every visible row through its epoch.
  const financialsRef = useRef(financialsMap);
  financialsRef.current = financialsMap;
  const flashSymbolsRef = useRef(safeFlashSymbols);
  flashSymbolsRef.current = safeFlashSymbols;
  const resolveCellRef = useRef({ resolve: resolveCell, epoch: 0 });
  if (resolveCellRef.current.resolve !== resolveCell) {
    resolveCellRef.current = { resolve: resolveCell, epoch: resolveCellRef.current.epoch + 1 };
  }
  const resolveEpoch = resolveCellRef.current.epoch;

  const renderCell = useCallback((
    ticker: TickerRecord,
    column: ColumnConfig,
    _index: number,
    rowState: { selected: boolean },
  ) => {
    const financials = financialsRef.current.get(ticker.metadata.ticker);
    if (column.id === PRICE_SPARKLINE_COLUMN_ID) {
      return {
        text: ticker.metadata.ticker,
        content: <PriceSparkline priceHistory={getPriceHistory(financials)} width={column.width} />,
      };
    }

    const { text, color } = resolveCellRef.current.resolve(column, ticker, financials);
    const shouldFlash = flashSymbolsRef.current.has(ticker.metadata.ticker)
      && FLASHABLE_QUOTE_COLUMN_IDS.has(column.id);
    return {
      text,
      color: color || (rowState.selected ? colors.selectedText : undefined),
      attributes: shouldFlash ? TextAttributes.DIM : TextAttributes.NONE,
    };
  }, []);

  const getRowVersion = useCallback((ticker: TickerRecord) => {
    const symbol = ticker.metadata.ticker;
    return `${resolveEpoch}|${objectVersion(financialsMap.get(symbol))}|${safeFlashSymbols.get(symbol) ?? ""}`;
  }, [financialsMap, resolveEpoch, safeFlashSymbols]);

  const selection = useMemo<DataTableSelection<TickerRecord>>(() => ({
    kind: "id",
    selectedId: cursorSymbol,
    getId: getTickerKey,
    onChange: (symbol) => {
      setCursorSymbol(symbol);
    },
  }), [cursorSymbol, setCursorSymbol]);

  const handleActivate = useCallback((ticker: TickerRecord) => {
    onRowActivate?.(ticker);
  }, [onRowActivate]);

  const showTickerContextMenu = useCallback((
    ticker: TickerRecord,
    event: TableMouseEvent,
  ) => {
    const financials = financialsRef.current.get(ticker.metadata.ticker);
    const registry = getSharedRegistry() ?? null;
    void showContextMenu(
      {
        kind: "ticker",
        symbol: ticker.metadata.ticker,
        ticker,
        financials: financials ?? null,
      },
      tickerContextMenuItems({
        ticker,
        financials: financials ?? null,
        registry,
        copyText: renderer.copyText.bind(renderer),
      }),
      event,
    );
  }, [renderer, showContextMenu]);

  const handleRowMouseDown = useCallback((ticker: TickerRecord, _index: number, event: TableMouseEvent) => {
    if (event.button !== 2) return false;
    if (nativeContextMenu !== true) {
      showTickerContextMenu(ticker, event);
    }
    return true;
  }, [nativeContextMenu, showTickerContextMenu]);

  const handleRowContextMenu = useCallback((ticker: TickerRecord, _index: number, event: TableMouseEvent) => {
    showTickerContextMenu(ticker, event);
  }, [showTickerContextMenu]);

  // The cursor row's right-click menu, for the keyboard, while the table is focused.
  const cursorTicker = selectedIndex >= 0 ? tickers[selectedIndex] ?? null : null;
  const cursorFinancials = cursorTicker ? financialsMap.get(cursorTicker.metadata.ticker) ?? null : null;
  useTickerRowPaneMenu({
    ticker: cursorTicker,
    financials: cursorFinancials,
    enabled: focused && keyboardNavigation,
    accelerators: rowMenuAccelerators,
  });

  return (
    <DataTableView<TickerRecord, ColumnConfig>
      focused={focused}
      columns={columns}
      items={tickers}
      sortColumnId={sortColumnId ?? null}
      sortDirection={sortDirection}
      onHeaderClick={onHeaderClick}
      getItemKey={getTickerKey}
      selection={selection}
      onCursorChange={onCursorChange}
      onActivate={handleActivate}
      onRowMouseDown={handleRowMouseDown}
      onRowContextMenu={handleRowContextMenu}
      rowContextMenuSurface
      renderCell={renderCell}
      getRowVersion={getRowVersion}
      emptyStateTitle={emptyTitle}
      emptyStateHint={resolvedEmptyHint}
      virtualize={virtualize}
      overscan={overscan}
      rootBefore={rootBefore}
      rootAfter={rootAfter}
      rootWidth={rootWidth}
      rootHeight={rootHeight}
      rootBackgroundColor={rootBackgroundColor}
      headerScrollRef={effectiveHeaderScrollRef}
      scrollRef={effectiveScrollRef}
      syncHeaderScroll={syncHeaderScroll}
      onBodyScrollActivity={handleBodyScrollActivity}
      keyboardNavigation={keyboardNavigation}
      onRootKeyDown={onRootKeyDown}
      resetScrollKey={resetScrollKey}
    />
  );
}
