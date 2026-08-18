/** @jsxImportSource react */
import { memo, type CSSProperties } from "react";
import { TextAttributes } from "../../../../ui/host";
import type {
  DataTableCell,
  DataTableColumn,
  DataTableProps,
  DataTableSectionHeader,
} from "../../../../components/ui/data-table";
import { WEB_CELL_HEIGHT } from "../input-host";
import {
  CSS_BG,
  CSS_PANEL,
  CSS_SELECTED,
  CSS_SELECTED_TEXT,
  CSS_TEXT,
  CSS_TEXT_BRIGHT,
  CSS_TEXT_DIM,
  TABLE_INLINE_PADDING_PX,
  cellTextStyle,
  clippedCellTextStyle,
  eventWithCellCoordinates,
} from "./dom";

function renderHeaderLabel<C extends DataTableColumn>(
  column: C,
  sortColumnId: string | null,
  sortDirection: "asc" | "desc",
) {
  const isSorted = sortColumnId === column.id;
  const indicator = isSorted ? (sortDirection === "asc" ? " ▲" : " ▼") : "";
  return {
    isSorted,
    text: column.label + indicator,
  };
}

function contentJustifyForAlign(align: string | undefined): CSSProperties["justifyContent"] {
  if (align === "right") return "flex-end";
  if (align === "center") return "center";
  return "flex-start";
}

function columnGapCss(columnGap: number): CSSProperties["columnGap"] {
  return columnGap === 0 ? 0 : `calc(${columnGap} * var(--cell-w))`;
}

function inlinePaddingPx(horizontalPadding: number): number {
  return TABLE_INLINE_PADDING_PX * horizontalPadding;
}

export function WebDataTableHeader<C extends DataTableColumn>({
  columns,
  columnGap,
  horizontalPadding,
  focusPane,
  onTableMouseDown,
  gridTemplateColumns,
  onHeaderClick,
  sortColumnId,
  sortDirection,
}: {
  columns: C[];
  columnGap: number;
  horizontalPadding: number;
  focusPane: () => void;
  onTableMouseDown?: (event: any) => void;
  gridTemplateColumns: string;
  onHeaderClick: (columnId: string) => void;
  sortColumnId: string | null;
  sortDirection: "asc" | "desc";
}) {
  return (
    <div
      data-gloom-role="data-table-header-row"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        display: "grid",
        gridTemplateColumns,
        columnGap: columnGapCss(columnGap),
        alignItems: "center",
        width: "100%",
        minWidth: 0,
        height: WEB_CELL_HEIGHT,
        paddingLeft: inlinePaddingPx(horizontalPadding),
        paddingRight: inlinePaddingPx(horizontalPadding),
        boxSizing: "border-box",
        backgroundColor: CSS_PANEL,
      }}
    >
      {columns.map((column) => {
        const { isSorted, text } = renderHeaderLabel(
          column,
          sortColumnId,
          sortDirection,
        );
        return (
          <div
            key={column.id}
            data-gloom-role="data-table-header-cell"
            data-gloom-interactive="true"
            style={{
              minWidth: 0,
              height: WEB_CELL_HEIGHT,
              overflow: "hidden",
              backgroundColor: column.headerBackgroundColor ?? CSS_PANEL,
            }}
            onMouseDown={(event) => {
              focusPane();
              onTableMouseDown?.(event);
              event.preventDefault();
              onHeaderClick(column.id);
            }}
          >
            <span
              title={text}
              style={{
                ...clippedCellTextStyle(
                  column,
                  isSorted ? CSS_TEXT : column.headerColor ?? CSS_TEXT_DIM,
                  TextAttributes.BOLD,
                ),
                whiteSpace: "pre",
              }}
            >
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WebDataTableRowInner<
  T,
  C extends DataTableColumn,
>({
  columns,
  columnGap,
  horizontalPadding,
  focusPane,
  onTableMouseDown,
  onActivateRow,
  onRowContextMenu,
  onRowMouseDown,
  onSelectRow,
  index,
  item,
  itemKey,
  gridTemplateColumns,
  getRowBackgroundColor,
  renderCell,
  renderSectionHeader,
  rowSize,
  rowStart,
  rowContextMenuSurface,
  selected,
}: {
  columns: C[];
  columnGap: number;
  horizontalPadding: number;
  focusPane: () => void;
  onTableMouseDown?: (event: any) => void;
  onActivateRow?: (item: T, index: number) => void;
  onRowContextMenu?: DataTableProps<T, C>["onRowContextMenu"];
  onRowMouseDown?: DataTableProps<T, C>["onRowMouseDown"];
  onSelectRow: (item: T, index: number) => void;
  index: number;
  item: T;
  itemKey: string;
  gridTemplateColumns: string;
  getRowBackgroundColor?: DataTableProps<T, C>["getRowBackgroundColor"];
  renderCell: DataTableProps<T, C>["renderCell"];
  renderSectionHeader?: DataTableProps<T, C>["renderSectionHeader"];
  rowSize: number;
  rowStart: number;
  rowContextMenuSurface: boolean;
  selected: boolean;
}) {
  const sectionHeader: DataTableSectionHeader | null =
    renderSectionHeader?.(item, index) ?? null;
  const baseRowStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    transform: `translateY(${rowStart}px)`,
    display: "grid",
    gridTemplateColumns,
    columnGap: columnGapCss(columnGap),
    alignItems: "center",
    width: "100%",
    minWidth: 0,
    height: rowSize,
    paddingLeft: inlinePaddingPx(horizontalPadding),
    paddingRight: inlinePaddingPx(horizontalPadding),
    boxSizing: "border-box",
    lineHeight: "var(--cell-h)",
  };

  if (sectionHeader) {
    return (
      <div
        key={itemKey}
        data-gloom-role="data-table-section-header"
        style={{
          ...baseRowStyle,
          backgroundColor: sectionHeader.backgroundColor ?? CSS_BG,
          cursor: sectionHeader.onMouseDown ? "pointer" : undefined,
        }}
        onMouseDown={(event) => {
          focusPane();
          onTableMouseDown?.(event);
          sectionHeader.onMouseDown?.(event);
          event.preventDefault();
        }}
      >
        <span
          title={sectionHeader.text}
          style={{
            ...cellTextStyle(
              sectionHeader.color ?? CSS_TEXT_BRIGHT,
              sectionHeader.attributes ?? TextAttributes.BOLD,
            ),
            gridColumn: "1 / -1",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {sectionHeader.text}
        </span>
      </div>
    );
  }

  const rowState = { selected };
  const rowBackgroundColor = getRowBackgroundColor?.(item, index, rowState);
  const rowBg = selected
    ? CSS_SELECTED
    : rowBackgroundColor ?? CSS_BG;

  return (
    <div
      key={itemKey}
      data-gloom-role="data-table-row"
      data-gloom-context-menu-surface={rowContextMenuSurface ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      style={{
        ...baseRowStyle,
        backgroundColor: rowBg,
      }}
      onMouseDown={(event) => {
        focusPane();
        onTableMouseDown?.(event);
        if (onRowMouseDown?.(item, index, eventWithCellCoordinates(event)) === true) {
          return;
        }
        event.preventDefault();
        onSelectRow(item, index);
      }}
      onContextMenu={(event) => {
        focusPane();
        onRowContextMenu?.(item, index, eventWithCellCoordinates(event));
      }}
      onDoubleClick={(event) => {
        focusPane();
        event.preventDefault();
        event.stopPropagation();
        onActivateRow?.(item, index);
      }}
    >
      {columns.map((column) => {
        const cell: DataTableCell = renderCell(item, column, index, rowState);
        return (
          <div
            key={column.id}
            data-gloom-role="data-table-cell"
            style={{
              minWidth: 0,
              height: WEB_CELL_HEIGHT,
              overflow: "hidden",
              backgroundColor: cell.backgroundColor ?? rowBg,
            }}
            onMouseDown={(event) => {
              focusPane();
              onTableMouseDown?.(event);
              if (cell.onMouseDown) {
                cell.onMouseDown(eventWithCellCoordinates(event));
                return;
              }
              if (onRowMouseDown?.(item, index, eventWithCellCoordinates(event)) === true) {
                event.stopPropagation();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onSelectRow(item, index);
            }}
            onDoubleClick={(event) => {
              if (cell.onMouseDown) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              focusPane();
              event.preventDefault();
              event.stopPropagation();
              onActivateRow?.(item, index);
            }}
          >
            {cell.content !== undefined ? (
              <div
                title={cell.text}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: contentJustifyForAlign(column.align),
                  width: "100%",
                  height: "100%",
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                {cell.content}
              </div>
            ) : (
              <span
                title={cell.text}
                style={clippedCellTextStyle(
                  column,
                  cell.color ?? (selected ? CSS_SELECTED_TEXT : CSS_TEXT),
                  cell.attributes ?? TextAttributes.NONE,
                )}
              >
                {cell.text}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const WebDataTableRow = memo(WebDataTableRowInner) as typeof WebDataTableRowInner;
