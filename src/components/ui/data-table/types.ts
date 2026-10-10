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
  flexGrow?: number;
};

export interface DataTableCell {
  text: string;
  /**
   * What CSV export writes instead of `text`: the full-precision number behind
   * it (3.45 for +3.45%, 1234567890 for 1.23B), or a date as an ISO string or
   * Date. `null` exports an empty cell. Without it, a right-aligned column of
   * numbers exports them read back from `text`.
   */
  value?: number | string | Date | null;
  content?: ReactNode;
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
}

export type DataTableScrollAlign = "nearest" | "center";

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
   * over the cell's own `color` unless it sets `keepColorWhenSelected`.
   * Without it only cells that leave `color` unset turn to that color.
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
  virtualize?: boolean;
  overscan?: number;
  columnGap?: number;
  horizontalPadding?: number;
  fillAvailableWidth?: boolean;
  showHorizontalScrollbar?: boolean;
  /** Keep the row identifier visible during horizontal scrolling. */
  freezeFirstColumn?: boolean;
  /** Append export-only source records after the displayed table. */
  getExportMetadata?: () => readonly (readonly unknown[])[];
  /**
   * A rendered-view report (`gloomberb fn`) reads every row, not only those
   * the viewport shows. For a bounded table a reader needs whole, such as an
   * option chain's strike window; leave it off for long or paged lists.
   */
  reportEveryRow?: boolean;
  scrollToIndex?: number | null;
  scrollToIndexAlign?: DataTableScrollAlign;
  scrollToIndexVersion?: number;
}
