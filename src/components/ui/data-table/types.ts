import type { ReactNode, RefObject } from "react";
import type { ScrollBoxRenderable } from "../../../ui";
import type { ColumnConfig } from "../../../types/config";

export type DataTableColumn = Pick<
  ColumnConfig,
  "id" | "label" | "width" | "align"
> & {
  headerColor?: string;
  headerBackgroundColor?: string;
  /**
   * Artwork drawn before the header label on the desktop and the web, such as
   * a flag. It is decoration: the terminal does not draw it, and exports,
   * automation and screen readers read only `label`.
   */
  headerLeading?: ReactNode;
  /**
   * The plain words behind a short label ("Impact" for IMP), shown on hover on
   * the desktop and the web. The terminal has no hover and shows `label` only.
   */
  title?: string;
  flexGrow?: number;
  /**
   * Every row can leave this column blank with nothing missing: its value
   * comes after an event the row is still waiting on (an earnings move, an
   * IPO's first-day return, a halt's resumption). `shot --strict` counts a
   * column blank in every row as data the pane lost, except this one.
   */
  mayBeBlank?: boolean;
};

export interface DataTableCell {
  text: string;
  /** Muted context after `text`, shown whole only when both fit on one line. Does not change the exported value. */
  note?: string;
  /**
   * The end of `text` a column too narrow for it keeps whole, with the space
   * before it: the cut shortens what comes first, so a contract's month
   * always shows ("Brent Crude Oil Last Day… Jan 2027"). Exports and reports
   * read `text` whole.
   */
  keepEnd?: string;
  /**
   * What CSV export writes instead of `text`: the full-precision number behind
   * it (3.45 for +3.45%, 1234567890 for 1.23B), or a date as an ISO string or
   * Date. `null` exports an empty cell. Without it, a right-aligned column of
   * numbers exports them read back from `text`.
   */
  value?: number | string | Date | null;
  /**
   * The unit `value` is in where `text` does not say it (USD for a market cap
   * shown as 72.26B). A column whose values share one names it in its export
   * header: MCAP (USD).
   */
  valueUnit?: string;
  content?: ReactNode;
  /**
   * The cells `content` takes to show whole in the terminal, where a table
   * fits its columns to what they hold before it cuts one or pushes one out of
   * view. Without it a drawn cell's column keeps the width the pane set.
   */
  contentWidth?: number;
  /**
   * Artwork drawn before `text` on the desktop and the web, such as a flag.
   * It is decoration: the terminal does not draw it, and exports, automation
   * and screen readers read only `text`. Unlike `content`, the text itself
   * keeps its clipping, alignment and selection color.
   */
  leading?: ReactNode;
  color?: string;
  /**
   * Keeps `color` on the selected row of a table with
   * `selectedTextOverridesCellColor`, for a tone the selection must not hide.
   */
  keepColorWhenSelected?: boolean;
  backgroundColor?: string;
  attributes?: number;
  onMouseDown?: (event: any) => void;
}

export interface DataTableSectionHeader {
  text: string;
  color?: string;
  backgroundColor?: string;
  attributes?: number;
  /** Makes the header itself clickable, e.g. to collapse its group. */
  onMouseDown?: (event: any) => void;
  /**
   * Set on a collapsible group: the renderer draws the disclosure marker, and
   * when `isNavigable` lets the cursor onto the header, Enter calls
   * `onMouseDown` instead of `onActivate`.
   */
  expanded?: boolean;
  /**
   * A quiet control at the right end of the header that acts on the whole
   * group, such as the preset its rows are set to. A header is not a stop for
   * the cursor, so the pane gives the same action a key (a footer hint).
   */
  action?: {
    /** What the control says, already translated: the group's current setting. */
    label: string;
    /** Desktop tooltip: what pressing it does. */
    title?: string;
    onPress: () => void;
  };
}

/** How a table's columns move when the reader drags a header (`DataTableProps.columnReorder`). */
export interface DataTableColumnReorder {
  /** How many leading columns stay first. Unset, the first column and the narrow marks before it (`rowAnchorColumnCount`). */
  anchored?: number;
  /**
   * Names this table's remembered order, for a pane that shows several
   * tables naming their rows with the same column whose other columns
   * differ. Unset, the id of the column that names the row (the last
   * anchored one).
   */
  key?: string;
  /**
   * The pane's own ordered list of the columns it shows, for a pane whose
   * settings choose and order them (an ordered-multi-select): a drag rewrites
   * that list instead of keeping an order of its own, so Settings and the
   * table agree.
   */
  control?: {
    order: readonly string[];
    /**
     * The list the pane shows while its setting is unset. Reset Columns puts
     * the list back in this order (without it the pane menu offers none),
     * and a list that comes out the same is `undefined` to `onChange`.
     */
    defaultOrder?: readonly string[];
    /** The list to keep, or undefined to remove the setting, so columns later added to the defaults reach the pane. */
    onChange: (order: string[] | undefined) => void;
  };
}

/** Where `scrollToIndex` puts its row: the nearest edge, the middle, or the top of the viewport. */
export type DataTableScrollAlign = "nearest" | "center" | "start";

interface DataTableRowState {
  selected: boolean;
}

export interface DataTableVisibleRange {
  /** First visible row index. */
  start: number;
  /** Exclusive end of the visible row range. */
  end: number;
}

export interface DataTableProps<
  T,
  C extends DataTableColumn = DataTableColumn,
> {
  columns: C[];
  items: T[];
  sortColumnId: string | null;
  sortDirection: "asc" | "desc";
  /** Sorts by a column. Without it the header is plain labels and ignores clicks. */
  onHeaderClick?: (columnId: string) => void;
  /**
   * Dragging a header moves its column (once the press moves a few pixels or
   * two cells; a click still sorts, on the release rather than the press),
   * and the pane remembers the order under `pane.columnOrder`: Reset
   * Columns in the pane menu puts the pane's own back. The columns that name
   * the row stay first. `false` keeps the pane's order, for columns that are
   * one ordered axis (periods, tenors, strikes) or a fixed format.
   */
  columnReorder?: false | DataTableColumnReorder;
  /** Set by `DataTable` from `columnReorder` for the renderer: moves a column to an index. Absent where the order is fixed. */
  onColumnMove?: (columnId: string, toIndex: number) => void;
  /** Set by `DataTable` with `onColumnMove`: the leading columns a drag neither moves nor drops before. */
  anchoredColumns?: number;
  headerScrollRef: RefObject<ScrollBoxRenderable | null>;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll: () => void;
  /** Controlled browser scrolling reports its origin; all scrolls still notify pagination. */
  onBodyScrollActivity: (source?: "programmatic" | "user") => void;
  headerScrollId?: string;
  bodyScrollId?: string;
  getItemKey: (item: T, index: number) => string;
  isSelected: (item: T, index: number) => boolean;
  onSelect: (item: T, index: number) => void;
  onActivate?: (item: T, index: number) => void;
  onTableMouseDown?: (event: any) => void;
  /** Changes when the meaning of row indexes changes without changing table geometry. */
  visibleRangeKey?: string | number;
  onVisibleRangeChange?: (range: DataTableVisibleRange) => void;
  /** Rows past each edge of the viewport that the reported range also covers. */
  visibleRangeBuffer?: number;
  onRowMouseDown?: (item: T, index: number, event: any) => boolean | void;
  onRowContextMenu?: (item: T, index: number, event: any) => void;
  rowContextMenuSurface?: boolean;
  renderCell: (
    item: T,
    column: C,
    index: number,
    rowState: DataTableRowState,
  ) => DataTableCell;
  /**
   * Draws every text cell of the selected row in the selection text color,
   * over the cell's own `color` unless it sets `keepColorWhenSelected` or the
   * color is the theme's up or down tone, which every table keeps on the
   * selected row (selectedRowCellColor). Without it only cells that leave
   * `color` unset turn to that color.
   */
  selectedTextOverridesCellColor?: boolean;
  /**
   * What a row's cells were drawn from, compared by identity. Visible rows are
   * memoized: one re-renders when its item, selection, version or `renderCell`
   * changes. A table whose cells read fast-changing data (quotes) keeps
   * `renderCell` stable and returns a version that changes with that row's
   * data, so one symbol's tick redraws one row instead of every visible cell.
   */
  getRowVersion?: (item: T, index: number) => unknown;
  renderSectionHeader?: (
    item: T,
    index: number,
  ) => DataTableSectionHeader | null;
  getRowBackgroundColor?: (
    item: T,
    index: number,
    rowState: DataTableRowState,
  ) => string | undefined;
  emptyContent?: ReactNode;
  bodyAfter?: ReactNode;
  emptyStateTitle: string;
  emptyStateHint?: string;
  /** Buttons under the empty state's title, for what the reader can do about it (Clear search). */
  emptyStateActions?: ReactNode;
  virtualize?: boolean;
  /**
   * Every row shows and nothing scrolls: a table set inline in a page, such as
   * a list of shortcuts. The terminal gives it the rows of the box it sits in;
   * the desktop and the web make it exactly as tall as its header and rows,
   * which a count of rows cannot, the header being a taller bar there.
   */
  fitRows?: boolean;
  overscan?: number;
  columnGap?: number;
  horizontalPadding?: number;
  fillAvailableWidth?: boolean;
  showHorizontalScrollbar?: boolean;
  /**
   * Keep the row identifier visible during horizontal scrolling. Unset, the
   * first column is pinned while the table is too wide for its viewport and
   * that column leaves the rest at least half of it (`tableFreezesFirstColumn`);
   * `false` lets it scroll away.
   */
  freezeFirstColumn?: boolean;
  /** Append export-only source records after the displayed table. */
  getExportMetadata?: () => readonly (readonly unknown[])[];
  /** What the table is of, which names its exported file (`Asia shock-2026-…csv`) in place of the pane's title. */
  exportName?: string;
  /**
   * Columns an export adds after the table's own, naming what each row is, as
   * `quote --csv` ends its rows (`QUOTE_EXPORT_IDENTITY_HEADERS`): their
   * headers, and each row's cells, or null for a row that is no record (a
   * summary line), which exports them empty.
   */
  exportIdentity?: {
    headers: readonly string[];
    cells: (item: T) => readonly unknown[] | null;
  };
  /**
   * What Export CSV writes in place of the rows drawn, for a pane whose
   * export is the data behind its view rather than one table: the backtest
   * writes its daily curve, as `fn BT --csv --equity` prints it.
   */
  exportCsv?: () => string;
  /**
   * A rendered-view report (`gloom fn`) reads every row, not only those
   * the viewport shows. For a bounded table a reader needs whole, such as an
   * option chain's strike window; leave it off for long or paged lists.
   */
  reportEveryRow?: boolean;
  /**
   * Columns a rendered-view report's JSON and CSV carry after the drawn ones,
   * which the table never draws and its text report leaves out: figures a
   * script reads that the view has no room for (FUT's 3M, 6M and 1Y
   * returns). `renderCell` renders them like any column. Read only with
   * `reportEveryRow`.
   */
  reportColumns?: readonly C[];
  scrollToIndex?: number | null;
  scrollToIndexAlign?: DataTableScrollAlign;
  scrollToIndexVersion?: number;
}
