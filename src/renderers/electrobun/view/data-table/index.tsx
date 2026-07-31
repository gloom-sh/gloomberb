/** @jsxImportSource react */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { TextAttributes } from "../../../../ui/host";
import { useAppDispatch, usePaneInstance } from "../../../../state/app/context";
import { useRafCallback } from "../../../../react/use-raf-callback";
import { measurePerf } from "../../../../utils/perf-marks";
import type {
  DataTableColumn,
  DataTableProps,
  DataTableVisibleRange,
} from "../../../../components/ui/data-table";
import { resolveDataTableVisibleRange } from "../../../../components/ui/data-table/visible-range";
import {
  buildTableGridTemplateColumns,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
} from "../../../../components/ui/table-layout";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";
import { useScrollbarActivity } from "../scrollbar-activity";
import {
  CSS_BG,
  CSS_TEXT_BRIGHT,
  CSS_TEXT_DIM,
  cellTextStyle,
  toCellX,
  toCellY,
  useScrollBoxHandle,
  useScrollbarState,
} from "./dom";
import { WebDataTableHeader, WebDataTableRow } from "./row";

interface VirtualRow {
  index: number;
  key: string | number;
  size: number;
  start: number;
}

export function WebDataTable<T, C extends DataTableColumn = DataTableColumn>({
  columns,
  items,
  sortColumnId,
  sortDirection,
  onHeaderClick,
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
  onRowMouseDown,
  onRowContextMenu,
  rowContextMenuSurface = false,
  renderCell,
  renderSectionHeader,
  getRowBackgroundColor,
  emptyContent,
  bodyAfter,
  emptyStateTitle,
  emptyStateHint,
  virtualize = true,
  overscan = 3,
  columnGap = 1,
  horizontalPadding = 1,
  fillAvailableWidth = true,
  showHorizontalScrollbar = true,
  scrollToIndex,
  scrollToIndexAlign = "nearest",
  scrollToIndexVersion = 0,
}: DataTableProps<T, C>) {
  const dispatch = useAppDispatch();
  const paneInstanceId = usePaneInstance()?.instanceId ?? null;
  const bodyElementRef = useRef<HTMLDivElement | null>(null);
  const lastVisibleRangeRef = useRef<{
    key: string | number | undefined;
    range: DataTableVisibleRange;
  } | null>(null);
  const headerHorizontal = useScrollbarState(false);
  const headerVertical = useScrollbarState(false);
  const bodyHorizontal = useScrollbarState(showHorizontalScrollbar);
  const bodyVertical = useScrollbarState(true);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollbarActive, markScrollbarActive] = useScrollbarActivity();
  const tableWidth = useMemo(
    () => getTableWidth(columns, columnGap, horizontalPadding),
    [columnGap, columns, horizontalPadding],
  );
  const gridTemplateColumns = useMemo(
    () => buildTableGridTemplateColumns(columns, fillAvailableWidth),
    [columns, fillAvailableWidth],
  );
  const selectRow = useCallback((item: T, index: number) => {
    onSelect(item, index);
  }, [onSelect]);
  const activateRow = useCallback((item: T, index: number) => {
    onActivate?.(item, index);
  }, [onActivate]);

  const focusPane = useCallback(() => {
    if (!paneInstanceId) return;
    dispatch({ type: "FOCUS_PANE", paneId: paneInstanceId });
  }, [dispatch, paneInstanceId]);

  const emitVisibleRange = useCallback(() => {
    if (!onVisibleRangeChange) return;
    const element = bodyElementRef.current;
    if (!element) return;
    const range = resolveDataTableVisibleRange({
      itemCount: items.length,
      rowSize: WEB_CELL_HEIGHT,
      scrollOffset: element.scrollTop,
      viewportSize: Math.max(0, element.clientHeight - WEB_CELL_HEIGHT),
    });
    const previous = lastVisibleRangeRef.current;
    if (
      previous !== null
      && previous.key === visibleRangeKey
      && previous.range.start === range.start
      && previous.range.end === range.end
    ) return;
    lastVisibleRangeRef.current = { key: visibleRangeKey, range };
    onVisibleRangeChange(range);
  }, [items.length, onVisibleRangeChange, visibleRangeKey]);
  const handleBodyScrollActivity = useCallback(() => {
    onBodyScrollActivity();
    emitVisibleRange();
  }, [emitVisibleRange, onBodyScrollActivity]);
  const scheduleBodyScrollActivity = useRafCallback(handleBodyScrollActivity);
  const scheduleVisibleRangeMeasure = useRafCallback(emitVisibleRange);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => bodyElementRef.current,
    estimateSize: () => WEB_CELL_HEIGHT,
    overscan,
    paddingStart: WEB_CELL_HEIGHT,
    scrollPaddingStart: WEB_CELL_HEIGHT,
  });

  const allRows = useMemo<VirtualRow[]>(
    () => {
      if (virtualize) return [];
      return Array.from({ length: items.length }, (_, index) => ({
        index,
        key: getItemKey(items[index]!, index),
        size: WEB_CELL_HEIGHT,
        start: WEB_CELL_HEIGHT + index * WEB_CELL_HEIGHT,
      }));
    },
    [getItemKey, items, virtualize],
  );
  const virtualRows = virtualize
    ? (rowVirtualizer.getVirtualItems() as VirtualRow[])
    : allRows;
  const totalHeight = virtualize
    ? rowVirtualizer.getTotalSize()
    : WEB_CELL_HEIGHT + items.length * WEB_CELL_HEIGHT;
  const bodyAfterHeight = bodyAfter ? WEB_CELL_HEIGHT * 6 : 0;
  const horizontalScrollEnabled = showHorizontalScrollbar
    && hasMeaningfulTableHorizontalOverflow(tableWidth, viewportWidth, columnGap);
  const scrollContentWidth = horizontalScrollEnabled
    || !fillAvailableWidth
    ? Math.max(1, tableWidth * WEB_CELL_WIDTH)
    : "100%";
  const measureViewportWidth = useCallback(() => {
    const element = bodyElementRef.current;
    const nextValue = element ? toCellX(element.clientWidth) : 0;
    setViewportWidth((current) => current === nextValue ? current : nextValue);
  }, []);
  const scheduleViewportWidthMeasure = useRafCallback(measureViewportWidth);

  useEffect(() => {
    measureViewportWidth();
    scheduleVisibleRangeMeasure();
    const element = bodyElementRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      scheduleViewportWidthMeasure();
      scheduleVisibleRangeMeasure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureViewportWidth, scheduleViewportWidthMeasure, scheduleVisibleRangeMeasure]);

  useEffect(() => {
    scheduleVisibleRangeMeasure();
  }, [items.length, scheduleVisibleRangeMeasure, visibleRangeKey]);

  useEffect(() => {
    if (scrollToIndex == null || items.length === 0) return;
    const targetIndex = Math.max(0, Math.min(scrollToIndex, items.length - 1));
    if (virtualize) {
      rowVirtualizer.scrollToIndex(targetIndex, {
        align: scrollToIndexAlign === "center" ? "center" : "auto",
      });
      scheduleVisibleRangeMeasure();
      return;
    }
    const element = bodyElementRef.current;
    if (!element) return;
    const viewportRows = Math.max(1, Math.floor(element.clientHeight / WEB_CELL_HEIGHT) - 1);
    const currentTop = toCellY(element.scrollTop);
    let nextTop = currentTop;
    if (scrollToIndexAlign === "center") {
      nextTop = Math.max(0, targetIndex - Math.floor(viewportRows / 2));
    } else if (targetIndex < currentTop) {
      nextTop = targetIndex;
    } else if (targetIndex >= currentTop + viewportRows) {
      nextTop = targetIndex - viewportRows + 1;
    }
    if (nextTop !== currentTop) {
      element.scrollTop = nextTop * WEB_CELL_HEIGHT;
    }
    scheduleVisibleRangeMeasure();
  }, [
    items.length,
    rowVirtualizer,
    scrollToIndex,
    scrollToIndexAlign,
    scrollToIndexVersion,
    scheduleVisibleRangeMeasure,
    virtualize,
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
    { viewportTopInsetPx: WEB_CELL_HEIGHT },
  );

  useEffect(() => {
    headerHorizontal.bar.visible = false;
    bodyHorizontal.bar.visible = horizontalScrollEnabled;
    if (!horizontalScrollEnabled) {
      if (bodyElementRef.current) bodyElementRef.current.scrollLeft = 0;
    }
  }, [bodyHorizontal.bar, headerHorizontal.bar, horizontalScrollEnabled]);

  const rootStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    flex: "1 1 0px",
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    backgroundColor: CSS_BG,
    overflow: "hidden",
  };
  const bodyScrollerStyle: CSSProperties = {
    width: "100%",
    flex: "1 1 0px",
    minWidth: 0,
    minHeight: 0,
    overflowX: horizontalScrollEnabled ? "auto" : "hidden",
    overflowY: "auto",
    backgroundColor: CSS_BG,
  };

  return (
    <div data-gloom-role="data-table" style={rootStyle}>
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
        onScroll={() => {
          markScrollbarActive();
          scheduleBodyScrollActivity();
        }}
        onWheel={() => {
          markScrollbarActive();
        }}
      >
        <div
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
            columnGap={columnGap}
            horizontalPadding={horizontalPadding}
            focusPane={focusPane}
            onTableMouseDown={onTableMouseDown}
            gridTemplateColumns={gridTemplateColumns}
            onHeaderClick={onHeaderClick}
            sortColumnId={sortColumnId}
            sortDirection={sortDirection}
          />
          {items.length === 0 ? (
            emptyContent ?? (
              <div
                style={{
                  width: "100%",
                  padding: `${WEB_CELL_HEIGHT}px ${WEB_CELL_WIDTH}px`,
                  color: CSS_TEXT_DIM,
                  lineHeight: "var(--cell-h)",
                }}
              >
                <div style={cellTextStyle(CSS_TEXT_BRIGHT, TextAttributes.BOLD)}>
                  {emptyStateTitle}
                </div>
                {emptyStateHint ? (
                  <div style={cellTextStyle(CSS_TEXT_DIM, TextAttributes.NONE)}>
                    {emptyStateHint}
                  </div>
                ) : null}
              </div>
            )
          ) : measurePerf(
            "data-table.desktop.render-virtual-rows",
            () =>
              virtualRows.map((row) => {
                const item = items[row.index];
                if (!item) return null;
                const selected = isSelected(item, row.index);
                const itemKey = getItemKey(item, row.index);
                return (
                  <WebDataTableRow<T, C>
                    key={itemKey}
                    rowSize={row.size}
                    rowStart={row.start}
                    index={row.index}
                    item={item}
                    itemKey={itemKey}
                    columns={columns}
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
                    selected={selected}
                  />
                );
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
    </div>
  );
}
