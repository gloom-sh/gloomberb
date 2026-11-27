import type { ReactNode, RefObject } from "react";
import type { ScrollBoxRenderable } from "../../../ui";
import type { ColumnConfig } from "../../../types/config";

export type DataTableColumn = Pick<
  ColumnConfig,
  "id" | "label" | "width" | "align"
> & {
  /** Opts the drawn header into a plugin translation. The raw `label` remains the fallback and export/report label. */
  labelTranslation?: { pluginId: string; key: string };
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
   * This column says what each row is though it does not come first: a
   * chain's strike between its calls and its puts. A table fitted to its
   * width never leaves it out, wherever the reader moved the other columns
   * (`DataTableProps.columnDropOrder`). Unset on every column, the leading
   * columns name the row (`anchoredColumns`).
   */
  identifiesRow?: boolean;
  /**
   * Every row can leave this column blank with nothing missing: its value
   * comes after an event the row is still waiting on (an earnings move, an
   * IPO's first-day return, a halt's resumption). `shot --strict` counts a
   * column blank in every row as data the pane lost, except this one.
   *
   * It exempts the whole column, so it is for a column no row ever owes, or a
   * column of controls. Where some rows owe the value, mark the cells that do
   * not (DataTableCell.mayBeBlank) and leave the column unmarked.
   */
  mayBeBlank?: boolean;
  /**
   * Leave this column out of the pane while every data row renders an empty
   * cell or MISSING_VALUE. Use for unavailable coverage, not a pending event
   * (mayBeBlank). "visible" checks just the rows wholly in view, for a
   * chronological history whose older rows have coverage its recent rows
   * lack. Scrolling restores the column when a row has a value. Reports and
   * CSV exports keep the column and its raw cells.
   */
  omitWhenEmpty?: boolean | "visible";
  /**
   * Leave this column out while every data row, two or more, renders the same
   * text, blank included: a value the whole view shares (one period, one
   * currency, one status) says nothing about any row. Set it only where the
   * rows are all the view holds: a paged feed whose next page may differ sets
   * it once nothing is left to load, or where its query fixes the value. A
   * lone row keeps its columns. A pane that should still say the shared value
   * puts it once in its header or footer. Reports and CSV exports keep the
   * column and its cells.
   */
  omitWhenSame?: boolean;
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
  /**
   * This row owes no value here, with nothing missing: it comes after an event
   * the row is still waiting on (an economic release not yet out), or the row
   * is of a kind that has none (a deal in talks has no terms). The column-wide
   * form is DataTableColumn.mayBeBlank; this one is for a column whose other
   * rows must have the value. `shot --strict` counts a column blank in every
   * other row as data the pane lost, and leaves this row out whatever its cell
   * shows: a dash, or words in place of the value (an event's label where a
   * call has its period). A marked cell never fills the column for the rows
   * that owe it, so a row that owes the value is never marked, filled or not.
   *
   * Set it from what else the row says (its status, its kind, its time), never
   * from the cell: a value that is null is not thereby optional, and words in
   * its place are not the value. Where the row cannot say which it is, leave
   * the cell unmarked and write the limit down beside the rule.
   */
  mayBeBlank?: boolean;
  content?: ReactNode;
  /**
   * The cells `content` takes to show whole in the terminal, where a table
   * fits its columns to what they hold before it cuts one or pushes one out of
   * view. Without it a drawn cell's column keeps the width the pane set.
   *
   * A cell that gives it is also made again for a column the pane's edge
   * cuts, with the cells that show as the column's width, so it can give up
   * a piece whole (a second link, a badge) where the edge would cut it.
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

/**
 * What a table that fits its columns to its width says about the fit and
 * takes back (`DataTableProps.columnFitRef`): set by `DataTable`, read by the
 * keys that step a table sideways.
 */
export interface DataTableColumnFit {
  /** How many columns the fit left out for width; 0 where every column is drawn. */
  hidden: number;
  /** The table is drawn fitted to its width: a column left out, or one set to grow narrowed. */
  fitted: boolean;
  /** Every column is drawn at the reader's asking, the table scrolling sideways past its edge. */
  all: boolean;
  /** Draws every column at its set width and scrolls to the first one the fit had left out. */
  showAll: () => void;
  /** Fits the columns to the width again. */
  fit: () => void;
}

/** Where `scrollToIndex` puts its row: the nearest edge, the middle, or the top of the viewport. */
export type DataTableScrollAlign = "nearest" | "center" | "start";

interface DataTableRowState {
  selected: boolean;
  /**
   * Terminal: the selected row's pane does not have the keys, so the row sits
   * on the quieter fill (`inactiveSelectedBg`) in its own colours. A colour a
   * cell picks for the selection is picked for that fill
   * (`inactiveSelectedText`).
   */
  inactive?: boolean;
}

export interface DataTableVisibleRange {
  /** First visible row index. */
  start: number;
  /** Exclusive end of the visible row range. */
  end: number;
  /**
   * The rows wholly in view, without the buffer, where they are not
   * start/end: a row the viewport cuts at an edge, drawn in part, is left
   * out. A capture that ends on a whole row draws exactly these.
   */
  wholeStart?: number;
  wholeEnd?: number;
}

/**
 * A row can follow independent external data without invalidating its table.
 * `version` is stable between notifications and changes when the row does.
 * `read` is pure and keeps the row key, order and geometry; change `items`
 * when those or omitWhenEmpty columns change.
 */
export interface DataTableRowSource<T> {
  subscribe(item: T, listener: () => void): () => void;
  version(item: T): number;
  read(item: T): T;
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
  /**
   * The columns this table gives up first where it is too narrow for all of
   * them, least needed first. An entry of several ids is a set that means
   * little apart (a call's field and the put's, a figure and the date it is
   * as of): it leaves whole, and stays whole while one of it names the row
   * or is the sorted column. Sets that share a column the table draws are
   * one set, so two figures that each list the date they share leave with it
   * or stay with it. On the desktop and the web a table too narrow
   * for its columns draws whole columns only: a column set to grow
   * (`flexGrow`) narrows first, then these leave, then the ones not listed
   * from the last back, never the columns that name the row
   * (`DataTableColumn.identifiesRow`, else the leading ones) or the one it is
   * sorted by, and never the row's last figure (`fitColumnsToWidth`). Where
   * what must stay does not fit, nothing is left out and the table scrolls
   * sideways. The table names what left (`2 hidden · FY2023, FY2022`), and
   * More, Shift+Right or Show All Columns in the pane menu draws them all
   * and scrolls sideways. Exports and reports keep every column. Unset, the
   * trailing columns leave first: list an order where a later column matters
   * more than an earlier one (a figure the pane is for, an as-of date). The
   * terminal fits what its columns hold and scrolls the rest
   * (`fitTableColumns`). A table set not to scroll sideways
   * (`showHorizontalScrollbar={false}`) narrows its columns to the pane there
   * and leaves none out.
   */
  columnDropOrder?: readonly (string | readonly string[])[];
  /** Set by `DataTable` for a renderer that cuts a column at its edge: the body's width in cells, as it measures it. */
  onViewportWidthChange?: (cells: number) => void;
  /** Set by `DataTable` while its fit left columns out: the press on the line that names them draws them all. */
  onShowAllColumns?: () => void;
  /** Set by `DataTable`: the column to scroll sideways into view, each time `version` changes. */
  scrollToColumn?: { id: string; version: number };
  /** Set by `DataTableView`: the table's fit, for the keys that step it sideways. */
  columnFitRef?: RefObject<DataTableColumnFit | null>;
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
  /** Independent updates for visible rows; `read` also supplies exports and reports. */
  rowSource?: DataTableRowSource<T>;
  renderSectionHeader?: (
    item: T,
    index: number,
  ) => DataTableSectionHeader | null;
  getRowBackgroundColor?: (
    item: T,
    index: number,
    rowState: DataTableRowState,
  ) => string | undefined;
  /**
   * A row that is shown but does not apply right now (a story or a print out
   * after the tab's pinned moment): the whole row reads in `textMuted` and
   * plain weight, its value colours and the content its cells draw (ticker
   * badges) included, and it stays selectable. One rule for every table, so a
   * pane does not mute its cells one by one.
   */
  isRowMuted?: (item: T, index: number) => boolean;
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
   * The rows Export CSV writes in place of `items`, for a table that draws
   * fewer rows than it holds: a watchlist writes the rows of a collapsed group too.
   */
  exportItems?: T[];
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
  /**
   * A row above `scrollToIndex` that comes into view with it, and every row
   * between: as many as fit with `scrollToIndex` still on screen. Ignored
   * when the target is centered.
   */
  scrollToIndexFrom?: number | null;
  scrollToIndexAlign?: DataTableScrollAlign;
  scrollToIndexVersion?: number;
}
