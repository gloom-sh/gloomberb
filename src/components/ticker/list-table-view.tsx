import {
  useCallback,
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
import { sectionHeaderText } from "../data-table/sections";
import type { QuoteFlashDirection } from "../quote-flash";
import type { DataTableColumnReorder } from "../ui";
import { objectVersion } from "../../utils/object-version";
import { getCompletedRegularSessionDisplay } from "../../market-data/market/status";
import { QUOTE_EXPORT_IDENTITY_HEADERS, quoteExportIdentityCells } from "../../market-data/quotes/export-identity";
import { exportedListingKey } from "../../portfolio/listed-symbol";
import { usePaneFooter } from "../layout/pane/footer";

export interface TickerTableCell {
  text: string;
  /** Muted context after `text`, shown whole only when both fit on one line. */
  note?: string;
  color?: string;
  /**
   * What exports and rendered-view reports keep behind a rounded `text`: the full-precision number, an ISO
   * date or time, or the listing with its venue (BA:LSE) behind a symbol drawn with its session dot.
   */
  value?: number | string | null;
  /** The unit `value` is in where `text` does not say it, which an export names in the header (MCAP (USD)). */
  valueUnit?: string;
  /** A tint behind a cell that stands out for a moment, such as a price that moved since the user last looked. */
  backgroundColor?: string;
  /**
   * Makes the cell a link: a click selects the row and calls this instead of
   * the row's own click. The pane gives the same action a key (its menu).
   */
  onPress?: () => void;
}

type ResolveTickerTableCell = (
  column: ColumnConfig,
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
) => TickerTableCell;

/**
 * A row after the tickers that adds them up, such as a book's FX line over a
 * period, its cash or its total: its cells by column id, read-only, with no
 * menu and nothing to open.
 */
export interface TickerTableSummaryRow {
  id: string;
  cells: Readonly<Record<string, Pick<TickerTableCell, "text" | "color" | "value">>>;
  /**
   * The cursor lands on it as on a ticker, so the pane's own actions reach the
   * line (a book's cash takes a target weight). The cursor is then at
   * `summaryRowKey(id)`. Never selected otherwise.
   */
  selectable?: boolean;
}

/** What the cursor reads on a selectable summary row: no ticker has this key. */
export function summaryRowKey(id: string): string {
  return `\u0000summary:${id}`;
}

/** The record a summary row stands in the table's items as, and the row it is. */
const summaryRowOf = new WeakMap<TickerRecord, TickerTableSummaryRow>();

function summaryRecord(row: TickerTableSummaryRow): TickerRecord {
  const record = { metadata: { ticker: summaryRowKey(row.id), exchange: "", currency: "", name: "", portfolios: [], watchlists: [], positions: [] } } as unknown as TickerRecord;
  summaryRowOf.set(record, row);
  return record;
}

/**
 * A section of a ticker table: a header that Enter or a click collapses and
 * expands, and the rows under it.
 */
export interface TickerTableGroup {
  /** The same while the group is: its header's row key (`groupRowKey`) and what its collapsed state is kept under. */
  id: string;
  label: string;
  /** Its rows in order, shown or collapsed: the header counts them and an export writes them all. */
  tickers: readonly TickerRecord[];
  collapsed: boolean;
}

const GROUP_ROW_PREFIX = "\u0000group:";

/** What the cursor reads on a group's header: no ticker has this key. */
export function groupRowKey(id: string): string {
  return `${GROUP_ROW_PREFIX}${id}`;
}

/** The group whose header a cursor key is, or null for any other row. */
export function groupIdOfRowKey(key: string | null): string | null {
  return key?.startsWith(GROUP_ROW_PREFIX) ? key.slice(GROUP_ROW_PREFIX.length) : null;
}

/** The record a group's header stands in the table's items as, and the group it heads. */
const groupHeaderOf = new WeakMap<TickerRecord, TickerTableGroup>();

function groupHeaderRecord(group: TickerTableGroup): TickerRecord {
  const record = { metadata: { ticker: groupRowKey(group.id), exchange: "", currency: "", name: "", portfolios: [], watchlists: [], positions: [] } } as unknown as TickerRecord;
  groupHeaderOf.set(record, group);
  return record;
}

const isTickerRow = (item: TickerRecord) => !summaryRowOf.has(item) && !groupHeaderOf.has(item);
/** Tickers, and the summary rows that take the cursor (CASH); never the others (TOTAL, a period's FX line). */
const isNavigableRow = (item: TickerRecord) => {
  const summary = summaryRowOf.get(item);
  return summary ? summary.selectable === true : true;
};

export interface TickerListVisibleRange {
  start: number;
  end: number;
}

export interface TickerListTableViewProps {
  /** What the list is (a watchlist's name), which names its exported file. */
  exportName?: string;
  /**
   * When a row's LAST is from, as its exported `as_of` dates it (an ISO time
   * or date; null for none), where the list knows better than the quote's
   * headline: a book valued at an after-hours print.
   */
  exportAsOf?: (ticker: TickerRecord) => string | null;
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
  /** Any press in the table: a row, a cell, the header or the empty body. */
  onTableMouseDown?: () => void;
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
  /** Rows after the tickers that add them up; shown only beside at least one ticker. */
  summaryRows?: readonly TickerTableSummaryRow[];
  /**
   * Sections the rows show under, in this order, each under a header the
   * cursor lands on. `tickers` still holds every row.
   */
  groups?: readonly TickerTableGroup[];
  /** Collapses or expands a group: Enter on its header, or a click. */
  onToggleGroup?: (id: string) => void;
  /** The pane's own items in a row's menu (right-click, and the pane menu for the cursor row), after the list items. */
  rowMenuItems?: (ticker: TickerRecord) => ContextMenuItem[];
  /**
   * The pane's own key for adding a ticker, which the empty table names. The
   * command bar's key when absent. The pane shows its add control once, in its
   * own row, so the empty table points at the key and offers no second one.
   */
  addTickerShortcut?: string;
  virtualize?: boolean;
  overscan?: number;
  /** How the header drags reorder the columns (`DataTableProps.columnReorder`). */
  columnReorder?: false | DataTableColumnReorder;
  /** What the list gives up first where it is too narrow for its columns (`DataTableProps.columnDropOrder`). */
  columnDropOrder?: readonly (string | readonly string[])[];
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

// After the regular close, and in the pre-market with the last session's close
// and move, these three hold that close and its move while only the extended
// print ticks (see the portfolio column values), so a tick does not flash them.
const STEADY_AFTER_CLOSE_QUOTE_COLUMN_IDS = new Set(["price", "change", "change_pct"]);

const EMPTY_FLASH_SYMBOLS = new Map<string, QuoteFlashDirection>();

/** Whether a tick on this row dims the cell: the quote columns it can move. */
export function flashesOnQuoteTick(columnId: string, quote: TickerFinancials["quote"]): boolean {
  if (!FLASHABLE_QUOTE_COLUMN_IDS.has(columnId)) return false;
  return !STEADY_AFTER_CLOSE_QUOTE_COLUMN_IDS.has(columnId) || !getCompletedRegularSessionDisplay(quote);
}

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

/** The pane's own row items, after the list items and before the actions plugins and the app add. */
function withPaneRowItems(items: ContextMenuItem[], paneItems: readonly ContextMenuItem[] | undefined): ContextMenuItem[] {
  if (!paneItems?.length) return items;
  const at = items.findIndex((item) => item.id === "ticker:actions-divider");
  return at < 0 ? [...items, ...paneItems] : [...items.slice(0, at), ...paneItems, ...items.slice(at)];
}

/** What right-clicking the row offers, plugin additions included. */
function tickerRowMenuItems(
  ticker: TickerRecord,
  financials: TickerFinancials | null,
  copyText: (text: string) => Promise<void>,
  paneItems?: readonly ContextMenuItem[],
): ContextMenuItem[] {
  const registry = getSharedRegistry() ?? null;
  return withPluginContextMenuItems(
    { kind: "ticker", symbol: ticker.metadata.ticker, ticker, financials },
    withPaneRowItems(tickerContextMenuItems({ ticker, financials, registry, copyText }), paneItems),
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
  paneItems,
}: {
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  enabled: boolean;
  /** The pane's own keys for these actions, by item id, shown beside them. */
  accelerators?: Readonly<Record<string, string>>;
  /** The pane's own items for this row (`TickerListTableViewProps.rowMenuItems`). */
  paneItems?: readonly ContextMenuItem[];
}): void {
  const renderer = useRendererHost();
  const registrationId = `ticker-row-menu:${useId()}`;
  usePaneFooter(registrationId, () => {
    if (!enabled || !ticker) return null;
    const items = tickerRowMenuItems(ticker, financials, renderer.copyText.bind(renderer), paneItems);
    return {
      order: -1,
      menu: accelerators
        ? items.map((item) => (item.type === "divider" || item.type === "role" || !accelerators[item.id]
          ? item
          : { ...item, accelerator: accelerators[item.id] }))
        : items,
    };
  }, [accelerators, enabled, financials, paneItems, renderer, ticker]);
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
  onTableMouseDown,
  onVisibleRangeChange,
  visibleRangeBuffer,
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
  addTickerShortcut,
  summaryRows,
  groups,
  onToggleGroup,
  rowMenuItems,
  virtualize = true,
  overscan = 4,
  exportName,
  exportAsOf,
  columnReorder,
  columnDropOrder,
}: TickerListTableViewProps) {
  const commandBarShortcut = useCommandBarShortcut();
  const resolvedEmptyHint = emptyHint ?? tf("Press {shortcut} to add one.", { shortcut: addTickerShortcut ?? commandBarShortcut });
  const renderer = useRendererHost();
  const { showContextMenu } = useContextMenu();
  const { nativeContextMenu } = useUiCapabilities();
  const safeFlashSymbols = flashSymbols ?? EMPTY_FLASH_SYMBOLS;
  const selectedIndex = useMemo(
    () => tickers.findIndex((ticker) => ticker.metadata.ticker === cursorSymbol),
    [cursorSymbol, tickers],
  );

  // A quote tick replaces the financials map and the flash set. The cell
  // renderer reads both through refs so it keeps one identity, and each row's
  // version carries its own records and flash, so one symbol's tick redraws
  // one row. A new `resolveCell` (another column context: FX, weights, the
  // AGE clock) still redraws every visible row through its epoch.
  const financialsRef = useRef(financialsMap);
  const exportAsOfRef = useRef(exportAsOf);
  exportAsOfRef.current = exportAsOf;
  financialsRef.current = financialsMap;
  const flashSymbolsRef = useRef(safeFlashSymbols);
  flashSymbolsRef.current = safeFlashSymbols;
  const resolveCellRef = useRef({ resolve: resolveCell, epoch: 0 });
  if (resolveCellRef.current.resolve !== resolveCell) {
    resolveCellRef.current = { resolve: resolveCell, epoch: resolveCellRef.current.epoch + 1 };
  }
  const resolveEpoch = resolveCellRef.current.epoch;
  const setCursorSymbolRef = useRef(setCursorSymbol);
  setCursorSymbolRef.current = setCursorSymbol;

  const renderCell = useCallback((
    ticker: TickerRecord,
    column: ColumnConfig,
    _index: number,
    rowState: { selected: boolean },
  ) => {
    // A group's header draws as a header, never as cells.
    if (groupHeaderOf.has(ticker)) return { text: "" };
    const summary = summaryRowOf.get(ticker);
    if (summary) {
      const cell = summary.cells[column.id];
      const color = cell?.color || (rowState.selected ? colors.selectedText : undefined);
      return { text: cell?.text ?? "", ...(color ? { color } : {}), ...(cell?.value !== undefined ? { value: cell.value } : {}), attributes: TextAttributes.NONE };
    }
    const financials = financialsRef.current.get(ticker.metadata.ticker);
    if (column.id === PRICE_SPARKLINE_COLUMN_ID) {
      // Drawn only: an export has no figure for it, so it leaves the column out (it wrote the ticker under 1M).
      return {
        text: "",
        content: <PriceSparkline priceHistory={getPriceHistory(financials)} width={column.width} />,
      };
    }

    const { text, note, color, onPress, value, valueUnit, backgroundColor } = resolveCellRef.current.resolve(column, ticker, financials);
    const shouldFlash = flashSymbolsRef.current.has(ticker.metadata.ticker)
      && flashesOnQuoteTick(column.id, financials?.quote);
    return {
      text,
      ...(note ? { note } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(valueUnit ? { valueUnit } : {}),
      color: color || (rowState.selected ? colors.selectedText : undefined),
      attributes: shouldFlash ? TextAttributes.DIM : TextAttributes.NONE,
      ...(backgroundColor ? { backgroundColor } : {}),
      // Any other button falls through to the row, so a right click still opens its menu.
      onMouseDown: onPress ? (event: TableMouseEvent) => {
        if ((event.button ?? 0) !== 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        setCursorSymbolRef.current(ticker.metadata.ticker);
        onPress();
      } : undefined,
    };
  }, []);

  const getRowVersion = useCallback((ticker: TickerRecord) => {
    const summary = summaryRowOf.get(ticker) ?? groupHeaderOf.get(ticker);
    if (summary) return summary;
    const symbol = ticker.metadata.ticker;
    return `${resolveEpoch}|${objectVersion(financialsMap.get(symbol))}|${safeFlashSymbols.get(symbol) ?? ""}`;
  }, [financialsMap, resolveEpoch, safeFlashSymbols]);

  // A grouped list's rows name their group in the export, collapsed or not.
  const groupLabels = useMemo(() => groups?.length
    ? new Map(groups.flatMap((group) => group.tickers.map((ticker) => [ticker.metadata.ticker, group.label] as const)))
    : null, [groups]);
  // An export ends each row as `quote --csv` does: its session and feed, its listing with the venue, its unit,
  // its source and the ISO time its price was observed. A summary line is no listing.
  const exportIdentity = useMemo(() => {
    const identity = (ticker: TickerRecord) => quoteExportIdentityCells(exportedListingKey(ticker), financialsRef.current.get(ticker.metadata.ticker)?.quote,
      Date.now(),
      // A broker's quote names the broker as its source.
      (providerId) => getSharedRegistry()?.getBrokerAdapter(providerId)?.name,
      // Dated as the row's LAST is, where the list says (a book valued at the latest print).
      exportAsOfRef.current?.(ticker));
    return groupLabels
      ? {
        headers: ["Group", ...QUOTE_EXPORT_IDENTITY_HEADERS],
        cells: (ticker: TickerRecord) => isTickerRow(ticker) ? [groupLabels.get(ticker.metadata.ticker) ?? "", ...identity(ticker)] : null,
      }
      : {
        headers: QUOTE_EXPORT_IDENTITY_HEADERS,
        cells: (ticker: TickerRecord) => isTickerRow(ticker) ? identity(ticker) : null,
      };
  }, [groupLabels]);

  const selection = useMemo<DataTableSelection<TickerRecord>>(() => ({
    kind: "id",
    selectedId: cursorSymbol,
    getId: getTickerKey,
    onChange: (symbol) => {
      setCursorSymbol(symbol);
    },
  }), [cursorSymbol, setCursorSymbol]);

  const handleActivate = useCallback((ticker: TickerRecord) => {
    if (isTickerRow(ticker)) onRowActivate?.(ticker);
  }, [onRowActivate]);

  const rowMenuItemsRef = useRef(rowMenuItems);
  rowMenuItemsRef.current = rowMenuItems;
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
      withPaneRowItems(tickerContextMenuItems({
        ticker,
        financials: financials ?? null,
        registry,
        copyText: renderer.copyText.bind(renderer),
      }), rowMenuItemsRef.current?.(ticker)),
      event,
    );
  }, [renderer, showContextMenu]);

  const handleRowMouseDown = useCallback((ticker: TickerRecord, _index: number, event: TableMouseEvent) => {
    // A click selects a summary row the cursor lands on (CASH); one it never lands on (TOTAL) keeps the cursor where it is.
    if (!isTickerRow(ticker)) return event.button === 2 || !isNavigableRow(ticker);
    if (event.button !== 2) return false;
    if (nativeContextMenu !== true) {
      showTickerContextMenu(ticker, event);
    }
    return true;
  }, [nativeContextMenu, showTickerContextMenu]);

  const handleRowContextMenu = useCallback((ticker: TickerRecord, _index: number, event: TableMouseEvent) => {
    if (isTickerRow(ticker)) showTickerContextMenu(ticker, event);
  }, [showTickerContextMenu]);

  // Summary rows follow the tickers, as records of their own the table never selects.
  const summaries = useMemo(() => tickers.length && summaryRows?.length ? summaryRows.map(summaryRecord) : [], [summaryRows, tickers.length]);
  // A grouped list shows each group's header and, unless it is collapsed, its rows.
  const grouped = useMemo(() => groups?.length
    ? groups.flatMap((group) => [groupHeaderRecord(group), ...group.collapsed ? [] : group.tickers])
    : null, [groups]);
  const rows = grouped ?? tickers;
  const items = useMemo(() => summaries.length ? [...rows, ...summaries] : rows, [rows, summaries]);
  // An export writes every row, a collapsed group's too, in the groups' order.
  const exportItems = useMemo(() => groups?.length
    ? [...groups.flatMap((group) => group.tickers), ...summaries]
    : undefined, [groups, summaries]);
  const toggleGroupRef = useRef(onToggleGroup);
  toggleGroupRef.current = onToggleGroup;
  const renderGroupHeader = useCallback((item: TickerRecord) => {
    const group = groupHeaderOf.get(item);
    return group
      ? { text: sectionHeaderText(group.label, group.tickers.length), expanded: !group.collapsed, onMouseDown: () => toggleGroupRef.current?.(group.id) }
      : null;
  }, []);
  // The pane counts the rows in view among its tickers: a header between them is not one.
  const handleVisibleRangeChange = useMemo(() => {
    if (!grouped || !onVisibleRangeChange) return onVisibleRangeChange;
    const tickersBefore = [0];
    for (const item of grouped) tickersBefore.push(tickersBefore.at(-1)! + (groupHeaderOf.has(item) ? 0 : 1));
    const at = (index: number) => tickersBefore[Math.max(0, Math.min(index, grouped.length))]!;
    return ({ start, end }: TickerListVisibleRange) => onVisibleRangeChange({ start: at(start), end: at(end) });
  }, [grouped, onVisibleRangeChange]);

  // The cursor row's right-click menu, for the keyboard, while the table is focused.
  const cursorTicker = selectedIndex >= 0 ? tickers[selectedIndex] ?? null : null;
  const cursorFinancials = cursorTicker ? financialsMap.get(cursorTicker.metadata.ticker) ?? null : null;
  const cursorPaneItems = useMemo(() => cursorTicker ? rowMenuItems?.(cursorTicker) : undefined, [cursorTicker, rowMenuItems]);
  useTickerRowPaneMenu({
    ticker: cursorTicker,
    financials: cursorFinancials,
    enabled: focused && keyboardNavigation,
    accelerators: rowMenuAccelerators,
    paneItems: cursorPaneItems,
  });

  return (
    <DataTableView<TickerRecord, ColumnConfig>
      focused={focused}
      columns={columns}
      columnReorder={columnReorder}
      columnDropOrder={columnDropOrder}
      items={items}
      isNavigable={summaries.length ? isNavigableRow : undefined}
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
      renderSectionHeader={grouped ? renderGroupHeader : undefined}
      exportIdentity={exportIdentity}
      exportItems={exportItems}
      exportName={exportName}
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
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={syncHeaderScroll}
      onBodyScrollActivity={onBodyScrollActivity}
      onVisibleRangeChange={handleVisibleRangeChange}
      visibleRangeBuffer={visibleRangeBuffer}
      keyboardNavigation={keyboardNavigation}
      onRootKeyDown={onRootKeyDown}
      onTableMouseDown={onTableMouseDown}
      resetScrollKey={resetScrollKey}
    />
  );
}
