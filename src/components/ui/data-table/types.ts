import type { ReactNode, RefObject } from "react";
import type { ScrollBoxRenderable } from "../../../ui";
import type { ColumnConfig } from "../../../types/config";

export type DataTableColumn = Pick<
  ColumnConfig,
  "id" | "label" | "width" | "align"
> & {
  headerColor?: string;
  headerBackgroundColor?: string;
  flexGrow?: number;
};

export interface DataTableCell {
  text: string;
  content?: ReactNode;
  color?: string;
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
}

export type DataTableScrollAlign = "nearest" | "center";

export interface DataTableRowState {
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
  onHeaderClick: (columnId: string) => void;
  headerScrollRef: RefObject<ScrollBoxRenderable | null>;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll: () => void;
  onBodyScrollActivity: () => void;
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
  onRowMouseDown?: (item: T, index: number, event: any) => boolean | void;
  onRowContextMenu?: (item: T, index: number, event: any) => void;
  rowContextMenuSurface?: boolean;
  renderCell: (
    item: T,
    column: C,
    index: number,
    rowState: DataTableRowState,
  ) => DataTableCell;
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
  scrollToIndex?: number | null;
  scrollToIndexAlign?: DataTableScrollAlign;
  scrollToIndexVersion?: number;
}
