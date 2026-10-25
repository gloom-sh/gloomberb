/** @jsxImportSource react */
import { memo, type CSSProperties, type ReactNode } from "react";
import { TextAttributes } from "../../../ui/host";
import { DisclosureMarker } from "../../../components/ui/disclosure-marker";
import type {
  DataTableCell,
  DataTableColumn,
  DataTableProps,
  DataTableSectionHeader,
} from "../../../components/ui/data-table";
import { tableColumnLeadGap } from "../../../components/ui/table-layout";
import { WebIcon } from "../desktop/icons";
import { useFrozenColumnInsets } from "./frozen-column";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import {
  CSS_BG,
  CSS_PANEL,
  CSS_SELECTED,
  CSS_SELECTED_TEXT,
  CSS_TEXT,
  CSS_TEXT_BRIGHT,
  CSS_TEXT_DIM,
  TABLE_INLINE_PADDING_PX,
  tableHeaderPx,
  cellTextStyle,
  clippedCellTextStyle,
  eventWithCellCoordinates,
} from "./dom";

/** Space between a label and its sort marker or the artwork drawn before it. */
const LABEL_GAP_PX = 4;
const SORT_MARKER_SIZE_PX = 9;

/**
 * Artwork a column or cell draws before its text. It is decoration, so
 * assistive technology skips it and the text stays the only name.
 */
function Leading({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      data-gloom-role="data-table-leading"
      style={{ display: "flex", flex: "none", alignItems: "center" }}
    >
      {children}
    </span>
  );
}

function contentJustifyForAlign(align: string | undefined): CSSProperties["justifyContent"] {
  if (align === "right") return "flex-end";
  if (align === "center") return "center";
  return "flex-start";
}

function columnGapCss(columnGap: number): CSSProperties["columnGap"] {
  return columnGap === 0 ? 0 : `calc(${columnGap} * var(--cell-w))`;
}

/**
 * The extra blank before a left-aligned column that follows a right-aligned
 * one. Its grid track already includes it; the cell steps past it as a margin,
 * so the frozen-column inset measured from the cell box stays right.
 */
function leadGapCss<C extends DataTableColumn>(columns: readonly C[], index: number, columnGap: number): CSSProperties["marginLeft"] {
  const lead = tableColumnLeadGap(columns, index, columnGap);
  return lead === 0 ? undefined : `calc(${lead} * var(--cell-w))`;
}

function inlinePaddingPx(horizontalPadding: number): number {
  return TABLE_INLINE_PADDING_PX * horizontalPadding;
}

export function WebDataTableHeader<C extends DataTableColumn>({
  columns,
  freezeFirstColumn,
  scrollLeft = 0,
  viewportWidth = 0,
  columnGap,
  horizontalPadding,
  focusPane,
  onTableMouseDown,
  gridTemplateColumns,
  sharedGrid,
  onHeaderClick,
  sortColumnId,
  sortDirection,
}: {
  columns: C[];
  freezeFirstColumn?: boolean;
  scrollLeft?: number;
  viewportWidth?: number;
  columnGap: number;
  horizontalPadding: number;
  focusPane: () => void;
  onTableMouseDown?: (event: any) => void;
  gridTemplateColumns: string;
  sharedGrid: boolean;
  onHeaderClick?: (columnId: string) => void;
  sortColumnId: string | null;
  sortDirection: "asc" | "desc";
}) {
  const { ref, insets } = useFrozenColumnInsets(freezeFirstColumn === true, scrollLeft, viewportWidth, columns, columnGap * WEB_CELL_WIDTH);
  return (
    <div
      ref={ref}
      data-gloom-role="data-table-header-row"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        display: "grid",
        gridTemplateColumns: sharedGrid ? "subgrid" : `var(--gloom-table-resize-columns, ${gridTemplateColumns})`,
        gridColumn: sharedGrid ? "1 / -1" : undefined,
        gridRow: sharedGrid ? 1 : undefined,
        transition: sharedGrid ? undefined : "var(--gloom-table-column-transition, none)",
        columnGap: columnGapCss(columnGap),
        alignItems: "center",
        width: sharedGrid ? undefined : "100%",
        marginLeft: sharedGrid ? -inlinePaddingPx(horizontalPadding) : undefined,
        marginRight: sharedGrid ? -inlinePaddingPx(horizontalPadding) : undefined,
        minWidth: 0,
        height: tableHeaderPx(),
        paddingLeft: inlinePaddingPx(horizontalPadding),
        paddingRight: inlinePaddingPx(horizontalPadding),
        boxSizing: "border-box",
        backgroundColor: CSS_PANEL,
      }}
    >
      {columns.map((column, columnIndex) => {
        const isSorted = sortColumnId === column.id;
        const color = isSorted ? CSS_TEXT : column.headerColor ?? CSS_TEXT_DIM;
        return (
          <div
            key={column.id}
            data-gloom-role="data-table-header-cell"
            data-gloom-interactive={onHeaderClick ? "true" : undefined}
            data-gloom-tinted={column.headerColor ? "true" : undefined}
            style={{
              minWidth: 0,
              position: freezeFirstColumn && columnIndex === 0 ? "sticky" : undefined,
              left: freezeFirstColumn && columnIndex === 0 ? inlinePaddingPx(horizontalPadding) : undefined,
              zIndex: freezeFirstColumn && columnIndex === 0 ? 1 : undefined,
              marginLeft: leadGapCss(columns, columnIndex, columnGap),
              paddingLeft: columnIndex > 0 ? insets[columnIndex] : undefined,
              boxSizing: "border-box",
              height: tableHeaderPx(),
              overflow: "hidden",
              // The sort marker sits on the side away from the column's
              // alignment, inside the two cells every column reserves for it,
              // so a label never moves when sorting reaches it and a
              // right-aligned label stays flush over its numbers.
              display: "flex",
              alignItems: "center",
              justifyContent: contentJustifyForAlign(column.align),
              gap: column.label ? LABEL_GAP_PX : 0,
              backgroundColor: column.headerBackgroundColor ?? CSS_PANEL,
              boxShadow: freezeFirstColumn && columnIndex === 0 ? `-${inlinePaddingPx(horizontalPadding)}px 0 0 ${column.headerBackgroundColor ?? CSS_PANEL}, ${columnGap * WEB_CELL_WIDTH}px 0 0 ${column.headerBackgroundColor ?? CSS_PANEL}` : undefined,
            }}
            onMouseDown={onHeaderClick ? (event) => {
              focusPane();
              onTableMouseDown?.(event);
              event.preventDefault();
              onHeaderClick(column.id);
            } : undefined}
          >
            {column.headerLeading !== undefined ? <Leading>{column.headerLeading}</Leading> : null}
            <span
              title={column.title ?? (column.label || undefined)}
              style={{
                ...clippedCellTextStyle(column, color, TextAttributes.BOLD),
                width: "auto",
                flex: "0 1 auto",
                // Fill the chrome-height header row so labels sit on its
                // centre line like the pane header and query bar above.
                lineHeight: `${tableHeaderPx()}px`,
                whiteSpace: "pre",
              }}
            >
              {column.label}
            </span>
            {isSorted ? (
              <span
                data-gloom-role="data-table-sort-marker"
                style={{ display: "flex", flex: "none", color, order: column.align === "right" ? -1 : undefined }}
              >
                <WebIcon name={sortDirection === "asc" ? "sort-up" : "sort-down"} size={SORT_MARKER_SIZE_PX} />
              </span>
            ) : null}
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
  freezeFirstColumn,
  scrollLeft = 0,
  viewportWidth = 0,
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
  getRowBackgroundColor,
  renderCell,
  renderSectionHeader,
  rowSize,
  rowStart,
  rowContextMenuSurface,
  selected,
  selectedTextOverridesCellColor,
}: {
  /** Only compared by the row memo; see `getRowVersion`. */
  rowVersion?: unknown;
  columns: C[];
  freezeFirstColumn?: boolean;
  scrollLeft?: number;
  viewportWidth?: number;
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
  getRowBackgroundColor?: DataTableProps<T, C>["getRowBackgroundColor"];
  renderCell: DataTableProps<T, C>["renderCell"];
  renderSectionHeader?: DataTableProps<T, C>["renderSectionHeader"];
  rowSize: number;
  rowStart: number;
  rowContextMenuSurface: boolean;
  selected: boolean;
  selectedTextOverridesCellColor: boolean;
}) {
  const { ref, insets } = useFrozenColumnInsets(freezeFirstColumn === true, scrollLeft, viewportWidth, columns, columnGap * WEB_CELL_WIDTH);
  const sectionHeader: DataTableSectionHeader | null =
    renderSectionHeader?.(item, index) ?? null;
  const baseRowStyle: CSSProperties = {
    position: "relative",
    top: rowStart,
    // Custom cell content stays below the sticky header, as it did inside
    // each virtual row's transform stacking context.
    zIndex: 0,
    display: "grid",
    // Rows overlap one grid area and retain their virtual Y
    // offsets. Their columns reuse one parent layout instead of laying the
    // same tracks out separately for every visible row on each pixel move.
    gridTemplateColumns: "subgrid",
    gridColumn: "1 / -1",
    gridRow: 1,
    columnGap: columnGapCss(columnGap),
    alignItems: "center",
    marginLeft: -inlinePaddingPx(horizontalPadding),
    marginRight: -inlinePaddingPx(horizontalPadding),
    minWidth: 0,
    height: rowSize,
    paddingLeft: inlinePaddingPx(horizontalPadding),
    paddingRight: inlinePaddingPx(horizontalPadding),
    boxSizing: "border-box",
    lineHeight: "var(--cell-h)",
  };

  if (sectionHeader) {
    // A header the cursor can land on (a collapsible group) shows it like a row.
    const headerColor = sectionHeader.color ?? (selected ? CSS_SELECTED_TEXT : CSS_TEXT_BRIGHT);
    const action = sectionHeader.action;
    return (
      <div
        key={itemKey}
        data-gloom-role="data-table-section-header"
        data-gloom-row-key={itemKey}
        data-selected={selected ? "true" : undefined}
        style={{
          ...baseRowStyle,
          backgroundColor: selected ? CSS_SELECTED : sectionHeader.backgroundColor ?? CSS_BG,
          cursor: sectionHeader.onMouseDown ? "pointer" : undefined,
        }}
        onMouseDown={(event) => {
          focusPane();
          onTableMouseDown?.(event);
          sectionHeader.onMouseDown?.(event);
          event.preventDefault();
        }}
      >
        <div
          title={sectionHeader.text}
          style={{
            ...cellTextStyle(
              headerColor,
              sectionHeader.attributes ?? TextAttributes.BOLD,
            ),
            gridColumn: "1 / -1",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "flex",
            alignItems: "center",
            gap: 4,
            // Kept to the columns in view, so a table wider than its pane does not push the action out of sight.
            ...(action ? { maxWidth: `calc(100cqw - ${inlinePaddingPx(horizontalPadding) * 2}px)` } : {}),
          }}
        >
          {sectionHeader.expanded !== undefined && (
            <DisclosureMarker expanded={sectionHeader.expanded} color={headerColor} />
          )}
          {action ? (
            <>
              <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{sectionHeader.text}</span>
              <button
                type="button"
                data-gloom-role="data-table-section-action"
                title={action.title ?? action.label}
                aria-haspopup="dialog"
                style={{ color: selected ? CSS_SELECTED_TEXT : CSS_TEXT }}
                onMouseDown={(event) => {
                  // The action, not the header's own press (a group's collapse).
                  event.stopPropagation();
                  focusPane();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onPress();
                }}
              >
                {action.label}
                <WebIcon name="chevron-down" size={9} />
              </button>
            </>
          ) : sectionHeader.text}
        </div>
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
      ref={ref}
      data-gloom-role="data-table-row"
      data-gloom-row-key={itemKey}
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
      {columns.map((column, columnIndex) => {
        const cell: DataTableCell = renderCell(item, column, index, rowState);
        const color = selected && (cell.color === undefined || (selectedTextOverridesCellColor && !cell.keepColorWhenSelected))
          ? CSS_SELECTED_TEXT
          : cell.color ?? CSS_TEXT;
        // Most cells are text. One clipping box can lay out and paint it;
        // nesting another full-width clip doubles the work during a resize.
        // Dim/inverse belong to the text alone, never its background.
        const plainText = cell.content === undefined && cell.leading === undefined
          && ((cell.attributes ?? TextAttributes.NONE) & (TextAttributes.DIM | TextAttributes.INVERSE)) === 0;
        // A number that fits keeps one intrinsic line box while its track
        // moves. Tints, pinned columns and cell-coordinate handlers retain
        // the full track; the row handles presses in a plain cell's blank.
        const directText = plainText && !freezeFirstColumn && !cell.onMouseDown && !onRowMouseDown
          && cell.backgroundColor === undefined && (selected || rowBackgroundColor === undefined);
        // Labels and italic text keep the track's clip: their glyphs can
        // paint beyond their advance width, which an intrinsic box shaves off.
        const intrinsicText = directText && column.align === "right"
          && ((cell.attributes ?? TextAttributes.NONE) & TextAttributes.ITALIC) === 0;
        const intrinsicChild = !directText && cell.content === undefined && cell.leading === undefined;
        const lead = tableColumnLeadGap(columns, columnIndex, columnGap);
        return (
          <div
            key={column.id}
            data-gloom-role="data-table-cell"
            title={directText ? cell.text : undefined}
            // The instant behind a shortened time ("Wed 11:27"), so a rendered-view report can print it whole.
            data-gloom-cell-instant={cell.value instanceof Date && Number.isFinite(cell.value.getTime()) ? cell.value.toISOString() : undefined}
            // The full-precision number behind a rounded cell (a trade of -9.4596 for -9.45963753), for the same reports.
            data-gloom-cell-value={typeof cell.value === "number" && Number.isFinite(cell.value) ? String(cell.value) : undefined}
            style={{
              ...(directText ? { ...clippedCellTextStyle(column, color, cell.attributes), width: undefined } : {}),
              ...(intrinsicText ? {
                width: "max-content",
                maxWidth: lead ? `calc(100% - ${lead} * var(--cell-w))` : "100%",
                justifySelf: "end",
              } : {}),
              ...(intrinsicChild ? {
                display: "flex",
                alignItems: "center",
                justifyContent: contentJustifyForAlign(column.align),
              } : {}),
              minWidth: 0,
              position: freezeFirstColumn && columnIndex === 0 ? "sticky" : undefined,
              left: freezeFirstColumn && columnIndex === 0 ? inlinePaddingPx(horizontalPadding) : undefined,
              zIndex: freezeFirstColumn && columnIndex === 0 ? 1 : undefined,
              marginLeft: leadGapCss(columns, columnIndex, columnGap),
              paddingLeft: columnIndex > 0 ? insets[columnIndex] : undefined,
              boxSizing: "border-box",
              height: WEB_CELL_HEIGHT,
              overflow: plainText ? "clip" : "hidden",
              cursor: cell.onMouseDown ? "pointer" : undefined,
              // The row already paints its solid fill. Only a frozen cell
              // (covering scrolled content) or a custom tint needs another.
              backgroundColor: cell.backgroundColor ?? (freezeFirstColumn && columnIndex === 0 || !selected && rowBackgroundColor !== undefined ? rowBg : undefined),
              boxShadow: freezeFirstColumn && columnIndex === 0 ? `-${inlinePaddingPx(horizontalPadding)}px 0 0 ${cell.backgroundColor ?? rowBg}, ${columnGap * WEB_CELL_WIDTH}px 0 0 ${cell.backgroundColor ?? rowBg}` : undefined,
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
            {directText ? cell.text : cell.content !== undefined ? (
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
              <CellText
                cell={cell}
                column={column}
                color={color}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CellText({ cell, column, color }: { cell: DataTableCell; column: DataTableColumn; color: string }) {
  const style = clippedCellTextStyle(column, color, cell.attributes ?? TextAttributes.NONE);
  const intrinsic = column.align === "right"
    && ((cell.attributes ?? TextAttributes.NONE) & TextAttributes.ITALIC) === 0;
  if (cell.leading === undefined) return (
    <span title={cell.text} style={{ ...style, width: intrinsic ? "max-content" : "100%", minWidth: 0, flex: "0 1 auto", overflow: "clip" }}>{cell.text}</span>
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: contentJustifyForAlign(column.align),
        gap: LABEL_GAP_PX,
        width: "100%",
        height: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <Leading>{cell.leading}</Leading>
      <span title={cell.text} style={{ ...style, width: "auto", flex: "0 1 auto" }}>{cell.text}</span>
    </div>
  );
}

export const WebDataTableRow = memo(WebDataTableRowInner) as typeof WebDataTableRowInner;
