/** @jsxImportSource react */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { EmptyState } from "../../../components/ui/status";
import { usePaneInstance } from "../../../state/app/context";
import { useRegisterPaneScrollBox } from "../../../state/pane-scroll-registry";
import { useRafCallback } from "../../../react/use-raf-callback";
import { measurePerf } from "../../../utils/perf-marks";
import type {
  DataTableColumn,
  DataTableProps,
} from "../../../components/ui/data-table";
import { resolveDataTableScrollTop } from "../../../components/ui/data-table/visible-range";
import { useFocusOwningPane, useVisibleRangeEmitter } from "../../../components/ui/data-table/hooks";
import { ObservedTableRow } from "../../../components/ui/data-table/observed-row";
import {
  buildTableGridTemplateColumns,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
  hiddenTableColumnDisclosure,
  tableFreezesFirstColumn,
} from "../../../components/ui/table-layout";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { isLiveResizing, onLiveResizeEnd } from "../../../ui/live-resize";
import { LivePaneFrameContext } from "../../../ui/live-stretch";
import { useScrollbarActivity } from "../scrollbar-activity";
import { useHorizontalScrollEdges } from "../host/overflow-fade";
import { trackTable } from "../host/surface-fit";
import {
  CSS_BG,
  CSS_PANEL,
  CSS_TEXT_DIM,
  tableHeaderPx,
  toCellX,
  toCellY,
  useScrollBoxHandle,
  useScrollbarState,
} from "./dom";
import { WebDataTableHeader, WebDataTableRow } from "./row";
import { useWebColumnDrag } from "./column-drag";

interface VirtualRow {
  index: number;
  key: string | number;
  size: number;
  start: number;
}

/** Width of the fade that marks columns hidden past a horizontal edge. */
const OVERFLOW_FADE_PX = 28;
/**
 * One part of the line that names the columns left out: cut with an ellipsis where the line is short of room. Two
 * parts give up length by how long each is, so a long one never leaves the other no room at all.
 */
const HIDDEN_COLUMNS_TEXT_STYLE: CSSProperties = {
  minWidth: 0, paddingInline: "var(--gloom-space-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};

/**
 * A fade over one horizontal edge of the table, drawn above the scroller
 * rather than as a mask on it so the vertical scrollbar stays crisp. The
 * header band fades into the header colour and the rows into the table's.
 */
function overflowFadeStyle(side: "left" | "right", offsetPx: number, bottomPx: number, topPx: number): CSSProperties {
  const direction = side === "left" ? "to left" : "to right";
  const headerPx = tableHeaderPx();
  return {
    position: "absolute",
    top: topPx,
    bottom: bottomPx,
    [side]: offsetPx,
    width: OVERFLOW_FADE_PX,
    zIndex: 3,
    pointerEvents: "none",
    background: [
      `linear-gradient(${direction}, transparent, ${CSS_PANEL}) 0 0 / 100% ${headerPx}px no-repeat`,
      `linear-gradient(${direction}, transparent, ${CSS_BG}) 0 ${headerPx}px / 100% calc(100% - ${headerPx}px) no-repeat`,
    ].join(", "),
  };
}

/**
 * The columns a table lays out, and the ref for its root. While a resize of
 * its pane lays the table out at the frame's width on every frame
 * (host/surface-fit.ts), it keeps the columns it had when the resize began:
 * the pane renders a few times a second meanwhile, and columns it sizes from
 * its width would move in whole cells at each of those, or overflow the
 * width the body was last measured at. Once the resize ends, the table takes
 * the columns the pane gives it at its final size.
 */
function useResizeHeldColumns<C>(columns: C[]): { columns: C[]; rootRef: RefObject<HTMLDivElement | null> } {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pane = useContext(LivePaneFrameContext);
  const followsRef = useRef(false);
  const heldRef = useRef(columns);
  const latestRef = useRef(columns);
  latestRef.current = columns;
  const [, settle] = useReducer((count: number) => count + 1, 0);
  if (!followsRef.current || pane?.live() == null) heldRef.current = columns;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return trackTable(root, (follows) => {
      followsRef.current = follows;
      if (!follows && heldRef.current !== latestRef.current) settle();
    });
  }, []);
  return { columns: heldRef.current, rootRef };
}

export function WebDataTable<T, C extends DataTableColumn = DataTableColumn>({
  columns: paneColumns,
  items,
  sortColumnId,
  sortDirection,
  onHeaderClick,
  onColumnMove,
  anchoredColumns = 1,
  headerScrollRef,
  scrollRef,
  syncHeaderScroll: _syncHeaderScroll,
  onBodyScrollActivity,
  getItemKey,
  isSelected,
  onSelect,
  onActivate,
  onTableMouseDown,
  visibleRangeKey,
  onVisibleRangeChange,
  visibleRangeBuffer,
  onRowMouseDown,
  onRowContextMenu,
  rowContextMenuSurface = false,
  renderCell,
  selectedTextOverridesCellColor = false,
  getRowVersion,
  rowSource,
  renderSectionHeader,
  getRowBackgroundColor,
  emptyContent,
  bodyAfter,
  emptyStateTitle,
  emptyStateHint,
  emptyStateActions,
  virtualize = true,
  fitRows = false,
  overscan = 3,
  columnGap = 1,
  horizontalPadding = 1,
  fillAvailableWidth = true,
  showHorizontalScrollbar = true,
  freezeFirstColumn: freezeFirstColumnProp,
  scrollToIndex,
  scrollToIndexFrom,
  scrollToIndexAlign = "nearest",
  scrollToIndexVersion = 0,
  onViewportWidthChange,
  onShowAllColumns,
  scrollToColumn,
}: DataTableProps<T, C>) {
  const paneInstanceId = usePaneInstance()?.instanceId ?? null;
  const focusPane = useFocusOwningPane();
  const { columns, rootRef: rootElementRef } = useResizeHeldColumns(paneColumns);
  const bodyElementRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const { drag: columnDrag, startPress: pressMovableHeader } = useWebColumnDrag({
    contentRef: contentElementRef,
    bodyRef: bodyElementRef,
    anchoredColumns,
    onColumnMove,
    onHeaderClick,
  });
  const headerHorizontal = useScrollbarState(false);
  const headerVertical = useScrollbarState(false);
  const bodyHorizontal = useScrollbarState(showHorizontalScrollbar);
  const bodyVertical = useScrollbarState(true);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [frozenScrollLeft, setFrozenScrollLeft] = useState(0);
  const [scrollbarActive, markScrollbarActive] = useScrollbarActivity();
  const tableWidth = useMemo(
    () => getTableWidth(columns, columnGap, horizontalPadding),
    [columnGap, columns, horizontalPadding],
  );
  const gridTemplateColumns = useMemo(
    () => buildTableGridTemplateColumns(columns, fillAvailableWidth, columnGap),
    [columnGap, columns, fillAvailableWidth],
  );
  const selectRow = useCallback((item: T, index: number) => {
    onSelect(item, index);
  }, [onSelect]);
  const activateRow = useCallback((item: T, index: number) => {
    onActivate?.(item, index);
  }, [onActivate]);

  const reportVisibleRange = useVisibleRangeEmitter({
    itemCount: items.length,
    visibleRangeKey,
    visibleRangeBuffer,
    onVisibleRangeChange,
  });
  const emitVisibleRange = useCallback(() => {
    const element = bodyElementRef.current;
    if (!element) return;
    reportVisibleRange({
      rowSize: WEB_CELL_HEIGHT,
      scrollOffset: element.scrollTop,
      viewportSize: Math.max(0, element.clientHeight - tableHeaderPx()),
    });
  }, [reportVisibleRange]);
  const handleBodyScrollActivity = useCallback(() => {
    onBodyScrollActivity();
    emitVisibleRange();
  }, [emitVisibleRange, onBodyScrollActivity]);
  const scheduleBodyScrollActivity = useRafCallback(handleBodyScrollActivity);
  const scheduleControlledScrollActivity = useRafCallback(() => {
    onBodyScrollActivity("programmatic");
    emitVisibleRange();
  });
  const scheduleVisibleRangeMeasure = useRafCallback(emitVisibleRange);
  const lastAppliedScrollRequestRef = useRef<string | null>(null);
  const controlledScrollOffsetRef = useRef<{ top: number; left: number } | null>(null);

  const headerPx = tableHeaderPx();
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => bodyElementRef.current,
    estimateSize: () => WEB_CELL_HEIGHT,
    overscan,
    paddingStart: headerPx,
    scrollPaddingStart: headerPx,
  });

  const allRows = useMemo<VirtualRow[]>(
    () => {
      if (virtualize) return [];
      return Array.from({ length: items.length }, (_, index) => ({
        index,
        key: getItemKey(items[index]!, index),
        size: WEB_CELL_HEIGHT,
        start: headerPx + index * WEB_CELL_HEIGHT,
      }));
    },
    [getItemKey, headerPx, items, virtualize],
  );
  const virtualRows = virtualize
    ? (rowVirtualizer.getVirtualItems() as VirtualRow[])
    : allRows;
  const totalHeight = virtualize
    ? rowVirtualizer.getTotalSize()
    : headerPx + items.length * WEB_CELL_HEIGHT;
  const bodyAfterHeight = bodyAfter ? WEB_CELL_HEIGHT * 6 : 0;
  const horizontalScrollEnabled = showHorizontalScrollbar
    && hasMeaningfulTableHorizontalOverflow(tableWidth, viewportWidth, columnGap);
  const freezeFirstColumn = tableFreezesFirstColumn({
    freezeFirstColumn: freezeFirstColumnProp, columns, columnGap, horizontalPadding, viewportWidth,
    overflows: horizontalScrollEnabled,
  });
  // A table that pins by default pins once scrolled: unscrolled nothing is under
  // its first column, so a pane dragged or resized at rest draws no sticky cells.
  const pinned = freezeFirstColumn && (freezeFirstColumnProp === true || frozenScrollLeft > 0);
  // Pinned from a scroll that came before it, it starts where the body is.
  useLayoutEffect(() => {
    if (freezeFirstColumn) setFrozenScrollLeft(bodyElementRef.current?.scrollLeft ?? 0);
  }, [freezeFirstColumn]);
  const scrollContentWidth = horizontalScrollEnabled
    || !fillAvailableWidth
    ? Math.max(1, tableWidth * WEB_CELL_WIDTH)
    : "100%";
  const reportViewportWidthRef = useRef(onViewportWidthChange);
  reportViewportWidthRef.current = onViewportWidthChange;
  const measureViewportWidth = useCallback(() => {
    const element = bodyElementRef.current;
    const nextValue = element ? toCellX(element.clientWidth) : 0;
    setViewportWidth((current) => current === nextValue ? current : nextValue);
    // The table fits its columns to this width: a column that would be cut at the edge leaves whole.
    if (nextValue > 0) reportViewportWidthRef.current?.(nextValue);
  }, []);
  const scheduleViewportWidthMeasure = useRafCallback(measureViewportWidth);
  // Measured before the first paint, so the table is never drawn with columns it is about to give up.
  useLayoutEffect(measureViewportWidth, [measureViewportWidth]);

  useEffect(() => {
    measureViewportWidth();
    scheduleVisibleRangeMeasure();
    const element = bodyElementRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      scheduleViewportWidthMeasure();
      scheduleVisibleRangeMeasure();
    };
    // While the pointer resizes the pane, its columns stretch by CSS and the
    // pane renders the table at the new size a few times a second; measuring
    // on every cell the body crosses would render it once per cell. It is
    // measured once the resize ends, a frame after its layout lands.
    let measureAfterResize = false;
    const observer = new ResizeObserver(() => {
      if (isLiveResizing()) measureAfterResize = true;
      else measure();
    });
    const stopListening = onLiveResizeEnd(() => {
      if (!measureAfterResize) return;
      measureAfterResize = false;
      measure();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      stopListening();
    };
  }, [measureViewportWidth, scheduleViewportWidthMeasure, scheduleVisibleRangeMeasure]);

  useEffect(() => {
    scheduleVisibleRangeMeasure();
  }, [items.length, scheduleVisibleRangeMeasure, visibleRangeKey]);

  // Rows sit on a whole-cell grid, so the offset is computed in rows and only
  // then converted to pixels. Letting the virtualizer scroll by pixels landed
  // mid-row and clipped the first and last visible rows into slivers.
  useEffect(() => {
    if (scrollToIndex == null || items.length === 0) {
      lastAppliedScrollRequestRef.current = null;
      if (items.length === 0 && bodyElementRef.current) {
        // Loading a different dataset removes the rows and the browser clamps
        // the old vertical offset to zero. Treat that ensuing scroll like our
        // own centering, so it cannot become a user's manual selection lock.
        controlledScrollOffsetRef.current = {
          top: 0,
          left: bodyElementRef.current.scrollLeft,
        };
      }
      return;
    }
    const scrollRequestKey = `${scrollToIndex}:${scrollToIndexFrom ?? ""}:${scrollToIndexVersion}:${scrollToIndexAlign}`;
    if (lastAppliedScrollRequestRef.current === scrollRequestKey) return;
    const targetIndex = Math.max(0, Math.min(scrollToIndex, items.length - 1));
    const element = bodyElementRef.current;
    if (!element) return;
    const viewportRows = Math.max(1, Math.floor((element.clientHeight - tableHeaderPx()) / WEB_CELL_HEIGHT));
    const currentTop = toCellY(element.scrollTop);
    const nextTop = resolveDataTableScrollTop(targetIndex, currentTop, viewportRows, items.length, scrollToIndexAlign, scrollToIndexFrom);
    if (nextTop !== currentTop) {
      element.scrollTop = nextTop * WEB_CELL_HEIGHT;
      // A controlled scroll is navigation requested by the app. Reporting it
      // as user activity makes panes such as options stop following the spot
      // price before the user has touched the table. Remember the actual
      // (possibly clamped) offset to recognize the ensuing native scroll event.
      controlledScrollOffsetRef.current = { top: element.scrollTop, left: element.scrollLeft };
      scheduleControlledScrollActivity();
    }
    lastAppliedScrollRequestRef.current = scrollRequestKey;
    scheduleVisibleRangeMeasure();
  }, [
    items.length,
    scrollToIndex,
    scrollToIndexAlign,
    scrollToIndexFrom,
    scrollToIndexVersion,
    scheduleControlledScrollActivity,
    scheduleVisibleRangeMeasure,
  ]);

  useScrollBoxHandle(
    headerScrollRef,
    bodyElementRef,
    headerHorizontal.bar,
    headerVertical.bar,
    { headerOnly: true },
  );
  useScrollBoxHandle(
    scrollRef,
    bodyElementRef,
    bodyHorizontal.bar,
    bodyVertical.bar,
    { viewportTopInsetPx: headerPx },
  );
  // The terminal table body is a ScrollBox the pane scroll keys already reach;
  // this is the same for the desktop one. A table with a cursor takes the keys
  // first, so only a table without one is scrolled by them.
  useRegisterPaneScrollBox(scrollRef, { enabled: true });

  useEffect(() => {
    headerHorizontal.bar.visible = false;
    bodyHorizontal.bar.visible = horizontalScrollEnabled;
    if (!horizontalScrollEnabled) {
      if (bodyElementRef.current) bodyElementRef.current.scrollLeft = 0;
    }
  }, [bodyHorizontal.bar, headerHorizontal.bar, horizontalScrollEnabled]);

  const overflowEdges = useHorizontalScrollEdges(bodyElementRef, [horizontalScrollEnabled]);
  // Every column drawn at the reader's asking: the first one the fit had left out is scrolled into view, whole,
  // past a frozen first column.
  const scrolledToColumnRef = useRef(scrollToColumn?.version);
  useLayoutEffect(() => {
    if (!scrollToColumn || scrolledToColumnRef.current === scrollToColumn.version) return;
    const body = bodyElementRef.current;
    const index = columns.findIndex((column) => column.id === scrollToColumn.id);
    const cells = body ? [...body.querySelectorAll<HTMLElement>('[data-gloom-role="data-table-header-cell"]')] : [];
    const cell = cells[index];
    if (!body || !cell || !horizontalScrollEnabled) return;
    scrolledToColumnRef.current = scrollToColumn.version;
    // Read off the page as it is laid out, before any scroll: the table's inset is where its first column starts,
    // and what stays in place ends where the second one does.
    const bounds = body.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const inset = (cells[0]?.getBoundingClientRect().left ?? bounds.left) - bounds.left;
    const stays = freezeFirstColumn && index > 0 && cells[1] ? cells[1].getBoundingClientRect().left - bounds.left : inset;
    const overRight = rect.right - (bounds.left + body.clientWidth);
    // No further than puts its left edge beside what stays (the frozen column, or the table's own edge).
    if (overRight > 0) body.scrollLeft += Math.min(overRight + inset, rect.left - bounds.left - stays);
  }, [columns, freezeFirstColumn, horizontalScrollEnabled, scrollToColumn]);
  const hiddenColumns = items.length ? hiddenTableColumnDisclosure(columns) : null;
  const disclosureHeight = hiddenColumns ? headerPx : 0;
  // A frozen first column already covers what scrolls under it, so the left
  // fade starts past it and its gap.
  const [frozenEdgePx, setFrozenEdgePx] = useState(0);
  useLayoutEffect(() => {
    const body = bodyElementRef.current;
    const frozenCell = pinned && overflowEdges.start
      ? body?.querySelector<HTMLElement>('[data-gloom-role="data-table-header-cell"]')
      : null;
    // The gap after it is the next column's margin, as laid out.
    const following = frozenCell?.nextElementSibling;
    const gap = following ? parseFloat(following.ownerDocument.defaultView?.getComputedStyle(following).marginLeft ?? "") || 0 : 0;
    const next = frozenCell && body
      ? Math.max(0, frozenCell.getBoundingClientRect().right - body.getBoundingClientRect().left + gap)
      : 0;
    // Set only on a change: a state update from a layout effect costs the render a second commit.
    if (next !== frozenEdgePx) setFrozenEdgePx(next);
  }, [columnGap, columns, pinned, frozenEdgePx, overflowEdges.start, viewportWidth]);

  const rootStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    // A table set inline in a page is as tall as its header and rows.
    flex: fitRows ? "0 0 auto" : "1 1 0px",
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    backgroundColor: CSS_BG,
    overflow: "hidden",
    // Its width comes from where it sits, never from its columns. When the
    // columns overflow, the content is laid out at their full width; in a box
    // that sizes to its content (a pane's side beside a sidebar), that widened
    // the box until they fit, which turned the scrolling off and narrowed it
    // again: a measure and a render every frame, at rest.
    contain: "inline-size",
  };
  const bodyScrollerStyle: CSSProperties = {
    width: "100%",
    // What is kept to the columns in view (a section header's action) measures the body in `cqw`.
    containerType: "inline-size",
    flex: fitRows ? "0 0 auto" : "1 1 0px",
    minWidth: 0,
    minHeight: 0,
    overflowX: horizontalScrollEnabled ? "auto" : "hidden",
    overflowY: fitRows ? "hidden" : "auto",
    backgroundColor: CSS_BG,
    // The table runs to the pane footer. A partly visible last row is how every
    // scrolling list reads; trimming the viewport to whole rows left a blank
    // strip above the footer, and a half row over it after a trackpad scroll.
  };

  return (
    <div ref={rootElementRef} data-gloom-role="data-table" style={rootStyle}>
      {hiddenColumns ? <div data-gloom-role="data-table-hidden-columns" style={{ flex: `0 0 ${disclosureHeight}px`, display: "flex",
        lineHeight: `${disclosureHeight}px`, color: CSS_TEXT_DIM, backgroundColor: CSS_PANEL }}>
        {/* What the pane left out for this width comes back with a wider pane only: it is named apart from what More draws. */}
        {hiddenColumns.pane ? <span data-gloom-role="data-table-hidden-by-pane" style={{ ...HIDDEN_COLUMNS_TEXT_STYLE, flex: "1 1 auto" }}
          title={hiddenColumns.pane}>{hiddenColumns.pane}</span> : null}
        {hiddenColumns.restorable ? <span data-gloom-role="data-table-hidden-by-fit"
          style={{ ...HIDDEN_COLUMNS_TEXT_STYLE, flex: hiddenColumns.pane ? "0 1 auto" : "1 1 0px" }}
          title={hiddenColumns.restorable}>{hiddenColumns.restorable}</span> : null}
        {onShowAllColumns && hiddenColumns.restorable ? (
          // The columns this table left out for width come back at a press: all drawn, scrolling sideways. Beside
          // columns the pane left out, the press is named by the word the line has for its own ("1 hidden").
          <button type="button" aria-label={hiddenColumns.pane ? "Show hidden columns" : "Show all columns"} onClick={() => { focusPane(); onShowAllColumns(); }}
            style={{ flex: "0 0 auto", cursor: "pointer", border: 0, height: disclosureHeight, paddingBlock: 0, paddingInline: "var(--gloom-space-sm)",
              background: CSS_PANEL, color: CSS_TEXT_DIM, font: "inherit" }}>
            More
          </button>
        ) : null}
      </div> : null}
      <div
        ref={bodyElementRef}
        data-gloom-role="data-table-body-scroll"
        data-gloom-scrollbar-x={
          horizontalScrollEnabled && bodyHorizontal.visible
            ? "visible"
            : "hidden"
        }
        data-gloom-scrollbar-y={bodyVertical.visible ? "visible" : "hidden"}
        data-gloom-scrollbar-active={scrollbarActive ? "true" : undefined}
        style={bodyScrollerStyle}
        onMouseDown={() => {
          focusPane();
          onTableMouseDown?.({});
        }}
        onScroll={(event) => {
          markScrollbarActive();
          if (freezeFirstColumn) {
            const left = event.currentTarget.scrollLeft;
            // Pinning on the first scroll away draws before that frame shows the column leaving.
            if (!pinned && left > 0) flushSync(() => setFrozenScrollLeft(left));
            else setFrozenScrollLeft(left);
          }
          const controlledOffset = controlledScrollOffsetRef.current;
          controlledScrollOffsetRef.current = null;
          if (controlledOffset
            && event.currentTarget.scrollTop === controlledOffset.top
            && event.currentTarget.scrollLeft === controlledOffset.left) {
            scheduleVisibleRangeMeasure();
            return;
          }
          scheduleBodyScrollActivity();
        }}
        onWheel={() => {
          controlledScrollOffsetRef.current = null;
          markScrollbarActive();
        }}
        onTouchMove={() => { controlledScrollOffsetRef.current = null; }}
      >
        <div
          ref={contentElementRef}
          data-gloom-role="data-table-scroll-content"
          style={{
            position: "relative",
            width: scrollContentWidth,
            height: items.length > 0 ? totalHeight + bodyAfterHeight : "100%",
            minHeight: WEB_CELL_HEIGHT,
          }}
        >
          <WebDataTableHeader
            columns={columns}
            freezeFirstColumn={pinned}
            scrollLeft={frozenScrollLeft}
            viewportWidth={pinned && frozenScrollLeft > 0 ? viewportWidth : 0}
            columnGap={columnGap}
            horizontalPadding={horizontalPadding}
            focusPane={focusPane}
            onTableMouseDown={onTableMouseDown}
            gridTemplateColumns={gridTemplateColumns}
            onHeaderClick={onHeaderClick}
            onMovableHeaderPress={onColumnMove ? pressMovableHeader : undefined}
            anchoredColumns={anchoredColumns}
            draggedColumn={columnDrag?.from ?? null}
            sortColumnId={sortColumnId}
            sortDirection={sortDirection}
          />
          {columnDrag?.dropLeft != null ? (
            <div
              data-gloom-role="data-table-drop-indicator"
              aria-hidden="true"
              style={{ left: columnDrag.dropLeft }}
            />
          ) : null}
          {items.length === 0 ? (
            emptyContent ?? (
              <EmptyBody body={bodyElementRef}>
                <EmptyState title={emptyStateTitle} hint={emptyStateHint} actions={emptyStateActions} />
              </EmptyBody>
            )
          ) : measurePerf(
            "data-table.desktop.render-virtual-rows",
            () =>
              virtualRows.map((row) => {
                const item = items[row.index];
                if (!item) return null;
                const selected = isSelected(item, row.index);
                const itemKey = getItemKey(item, row.index);
                const renderRow = (item: T) => (
                  <WebDataTableRow<T, C>
                    key={itemKey}
                    rowSize={row.size}
                    rowStart={row.start}
                    index={row.index}
                    item={item}
                    itemKey={itemKey}
                    columns={columns}
                    freezeFirstColumn={pinned}
                    scrollLeft={frozenScrollLeft}
                    // Only a frozen first column scrolled past places itself by it: every
                    // other row stays memoized when the viewport changes width.
                    viewportWidth={pinned && frozenScrollLeft > 0 ? viewportWidth : 0}
                    columnGap={columnGap}
                    horizontalPadding={horizontalPadding}
                    focusPane={focusPane}
                    onTableMouseDown={onTableMouseDown}
                    gridTemplateColumns={gridTemplateColumns}
                    onActivateRow={onActivate ? activateRow : undefined}
                    onRowContextMenu={onRowContextMenu}
                    onRowMouseDown={onRowMouseDown}
                    onSelectRow={selectRow}
                    getRowBackgroundColor={getRowBackgroundColor}
                    renderCell={renderCell}
                    renderSectionHeader={renderSectionHeader}
                    rowContextMenuSurface={rowContextMenuSurface}
                    rowVersion={getRowVersion?.(item, row.index)}
                    selected={selected}
                    selectedTextOverridesCellColor={selectedTextOverridesCellColor}
                  />
                );
                return rowSource ? <ObservedTableRow key={itemKey} item={item} source={rowSource}>{renderRow}</ObservedTableRow> : renderRow(item);
              }),
            {
              columnCount: columns.length,
              itemCount: items.length,
              paneId: paneInstanceId,
              renderedCount: virtualRows.length,
              virtualize,
            },
          )}
          {items.length > 0 && bodyAfter ? (
            <div
              data-gloom-role="data-table-body-after"
              style={{
                position: "absolute",
                top: totalHeight,
                left: 0,
                width: "100%",
                minHeight: bodyAfterHeight,
              }}
            >
              {bodyAfter}
            </div>
          ) : null}
        </div>
      </div>
      {horizontalScrollEnabled && overflowEdges.start ? (
        <div
          data-gloom-role="data-table-overflow-fade"
          data-gloom-edge="left"
          style={overflowFadeStyle("left", frozenEdgePx, overflowEdges.scrollbarBottom, disclosureHeight)}
        />
      ) : null}
      {horizontalScrollEnabled && overflowEdges.end ? (
        <div
          data-gloom-role="data-table-overflow-fade"
          data-gloom-edge="right"
          style={overflowFadeStyle("right", overflowEdges.scrollbarRight, overflowEdges.scrollbarBottom, disclosureHeight)}
        />
      ) : null}
      {horizontalScrollEnabled && overflowEdges.end && items.length ? (
        <button type="button" aria-label="Show more columns" onClick={() => {
          const body = bodyElementRef.current;
          if (!body) return;
          focusPane();
          const bounds = body.getBoundingClientRect();
          const visibleRight = bounds.left + body.clientWidth;
          const next = [...body.querySelectorAll<HTMLElement>('[data-gloom-role="data-table-header-cell"]')]
            .map((cell) => cell.getBoundingClientRect()).find((cell) => cell.right > visibleRight + 1 && cell.left > bounds.left + frozenEdgePx + 1);
          body.scrollLeft += next ? next.left - bounds.left - frozenEdgePx : body.clientWidth - frozenEdgePx;
        }} style={{ position: "absolute", insetInlineEnd: overflowEdges.scrollbarRight, top: disclosureHeight, zIndex: 4,
          cursor: "pointer", border: 0, height: headerPx, background: CSS_PANEL, color: CSS_TEXT_DIM, font: "inherit" }}>
          More
        </button>
      ) : null}
    </div>
  );
}

/**
 * An empty table's message, as wide as the body shows: it stays in view
 * however wide the columns scroll. Read from the body's laid-out width, and
 * set on the element, so a resize does not render the table.
 */
function EmptyBody({ body, children }: { body: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current, scroller = body.current;
    if (!element || !scroller) return;
    const fit = () => {
      element.style.width = scroller.clientWidth > 0 ? `${scroller.clientWidth}px` : "100%";
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [body]);
  return (
    <div
      ref={ref}
      data-gloom-role="data-table-empty"
      style={{
        maxWidth: "100%",
        boxSizing: "border-box",
        position: "sticky",
        left: 0,
        padding: `${WEB_CELL_HEIGHT}px ${WEB_CELL_WIDTH}px`,
        color: CSS_TEXT_DIM,
        lineHeight: "var(--cell-h)",
      }}
    >
      {children}
    </div>
  );
}
