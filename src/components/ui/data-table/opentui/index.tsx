import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, useNativeRenderer } from "../../../../ui";
import { hoverBg } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { useAppDispatch, usePaneInstance } from "../../../../state/app/context";
import { useViewport } from "../../../../react/input";
import { measurePerf } from "../../../../utils/perf-marks";
import { useDoubleClickActivation } from "../../../use-double-click-activation";
import { useScrollBoxScrollActivity } from "../../../table-view-shared";
import { EmptyState } from "../../status";
import { observeScrollBoxContentSize, observeScrollBoxViewportSize } from "../../../../renderers/opentui/scrollbox-layout";
import {
  expandTableColumns,
  fitTableCellText,
  fitTableHeaderText,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
  tableColumnLeadGap,
  tableColumnStarts,
  tableContentWidthProps,
  useMeasuredTableContentWidth,
} from "../../table-layout";
import type {
  DataTableColumn,
  DataTableProps,
  DataTableVisibleRange,
} from "../types";
import { resolveDataTableVisibleRange } from "../visible-range";
import { useStableColumns } from "../stable-columns";
import {
  resolveDataTableScrollTop,
  resolveDataTableVisibleWindow,
} from "./model";

interface DataTableRowPointerTarget<T> {
  item: T;
  index: number;
}

type ManagedScrollBar = {
  visible: boolean;
  resetVisibilityControl?: () => void;
};

function setScrollBarVisible(scrollBar: unknown, visible: boolean): void {
  const bar = scrollBar as ManagedScrollBar | undefined;
  if (!bar) return;
  if (visible && bar.resetVisibilityControl) {
    bar.resetVisibilityControl();
    return;
  }
  bar.visible = visible;
}

function OpenTuiDataTableRowInner<
  T,
  C extends DataTableColumn,
>({
  colors,
  columnGap,
  columnStarts,
  contentWidth,
  displayColumns,
  focusPane,
  frozenColumnOffset,
  getRowBackgroundColor,
  handleRowMouseDown,
  horizontalPadding,
  index,
  item,
  itemKey,
  onRowContextMenu,
  onRowMouseDown,
  onTableMouseDown,
  renderCell,
  renderSectionHeader,
  rowContextMenuSurface,
  selected,
}: {
  /** Only compared by the row memo; see `getRowVersion`. */
  rowVersion?: unknown;
  colors: ReturnType<typeof useThemeColors>;
  columnGap: number;
  columnStarts: number[];
  contentWidth: number;
  displayColumns: C[];
  focusPane: () => void;
  frozenColumnOffset?: number;
  getRowBackgroundColor?: DataTableProps<T, C>["getRowBackgroundColor"];
  handleRowMouseDown: (
    targetKey: string,
    value: DataTableRowPointerTarget<T>,
    event?: { detail?: number },
  ) => void;
  horizontalPadding: number;
  index: number;
  item: T;
  itemKey: string;
  onRowContextMenu?: DataTableProps<T, C>["onRowContextMenu"];
  onRowMouseDown?: DataTableProps<T, C>["onRowMouseDown"];
  onTableMouseDown?: DataTableProps<T, C>["onTableMouseDown"];
  renderCell: DataTableProps<T, C>["renderCell"];
  renderSectionHeader?: DataTableProps<T, C>["renderSectionHeader"];
  rowContextMenuSurface: boolean;
  selected: boolean;
}) {
  const sectionHeader = renderSectionHeader?.(item, index) ?? null;

  if (sectionHeader) {
    // A header the cursor can land on (a collapsible group) shows it like a row.
    const headerColor = sectionHeader.color ?? (selected ? colors.selectedText : colors.textBright);
    return (
      <Box
        flexDirection="row"
        height={1}
        {...tableContentWidthProps(contentWidth)}
        paddingX={horizontalPadding}
        backgroundColor={selected ? colors.selected : sectionHeader.backgroundColor ?? colors.bg}
        onMouseDown={(event: any) => {
          focusPane();
          onTableMouseDown?.(event);
          sectionHeader.onMouseDown?.(event);
          event.preventDefault();
        }}
      >
        {sectionHeader.expanded !== undefined && (
          <Text fg={headerColor}>{sectionHeader.expanded ? "\u25be " : "\u25b8 "}</Text>
        )}
        <Text
          attributes={sectionHeader.attributes ?? TextAttributes.BOLD}
          fg={headerColor}
        >
          {sectionHeader.text}
        </Text>
      </Box>
    );
  }

  const rowState = { selected };
  const rowBackgroundColor = getRowBackgroundColor?.(item, index, rowState);
  const rowBg = selected ? colors.selected : rowBackgroundColor ?? colors.bg;
  const rowHoverBg = selected ? undefined : hoverBg(colors);

  return (
    <Box
      flexDirection="row"
      height={1}
      {...tableContentWidthProps(contentWidth)}
      paddingX={horizontalPadding}
      backgroundColor={rowBg}
      hoverBackgroundColor={rowHoverBg}
      data-gloom-context-menu-surface={rowContextMenuSurface ? "true" : undefined}
      onMouseDown={(event: any) => {
        focusPane();
        onTableMouseDown?.(event);
        if (onRowMouseDown?.(item, index, event) === true) return;
        event.preventDefault();
        handleRowMouseDown(itemKey, { item, index }, event);
      }}
      onContextMenu={(event: any) => {
        focusPane();
        onRowContextMenu?.(item, index, event);
      }}
    >
      {displayColumns.map((column, columnIndex) => {
        const cell = renderCell(item, column, index, rowState);
        const frozen = columnIndex === 0 && frozenColumnOffset !== undefined;
        const columnStart = columnStarts[columnIndex] ?? 0;
        const leadGap = tableColumnLeadGap(displayColumns, columnIndex, columnGap);
        const inset = !frozen && frozenColumnOffset !== undefined
          ? Math.min(column.width, Math.max(0, frozenColumnOffset + (displayColumns[0]?.width ?? 0) + columnGap - columnStart)) : 0;
        return (
          <Box
            key={column.id}
            width={column.width + columnGap + (frozen ? horizontalPadding : 0)}
            marginLeft={frozen ? -horizontalPadding : leadGap}
            position="relative"
            left={frozen ? frozenColumnOffset : undefined}
            zIndex={frozen ? 1 : undefined}
            backgroundColor={cell.backgroundColor ?? rowBg}
            onMouseDown={(event: any) => {
              focusPane();
              onTableMouseDown?.(event);
              if (cell.onMouseDown) {
                cell.onMouseDown(event);
                return;
              }
              if (onRowMouseDown?.(item, index, event) === true) {
                event.stopPropagation?.();
                return;
              }
              event.preventDefault();
              event.stopPropagation?.();
              handleRowMouseDown(itemKey, { item, index }, event);
            }}
          >
            {cell.content !== undefined ? (frozenColumnOffset === undefined ? cell.content : (
              <>
                {frozen && <Text position="absolute" left={0} top={0}>{" ".repeat(column.width + columnGap + horizontalPadding)}</Text>}
                <Box marginLeft={frozen ? horizontalPadding : inset} width={Math.max(0, column.width - inset)} overflow="hidden">
                  {cell.content}
                </Box>
              </>
            )) : (
              <Text
                attributes={cell.attributes ?? TextAttributes.NONE}
                fg={cell.color ?? (selected ? colors.selectedText : colors.text)}
              >
                {`${frozen ? " ".repeat(horizontalPadding) : ""}${" ".repeat(inset)}${inset < column.width ? fitTableCellText(cell.text, column.width - inset, column.align) : ""}${frozen ? " ".repeat(columnGap) : ""}`}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

const OpenTuiDataTableRow = memo(OpenTuiDataTableRowInner) as typeof OpenTuiDataTableRowInner;

export function OpenTuiDataTable<T, C extends DataTableColumn = DataTableColumn>({
  columns: columnsProp,
  items,
  sortColumnId,
  sortDirection,
  onHeaderClick,
  headerScrollRef,
  scrollRef,
  syncHeaderScroll,
  onBodyScrollActivity,
  headerScrollId,
  bodyScrollId,
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
  getRowVersion,
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
  freezeFirstColumn = false,
  scrollToIndex,
  scrollToIndexAlign = "nearest",
  scrollToIndexVersion = 0,
}: DataTableProps<T, C>) {
  const columns = useStableColumns(columnsProp);
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const paneInstanceId = usePaneInstance()?.instanceId ?? null;
  const appViewport = useViewport();
  const nativeRenderer = useNativeRenderer();
  const [scrollVersion, setScrollVersion] = useState(0);
  const [frozenColumnOffset, setFrozenColumnOffset] = useState(0);
  useEffect(() => {
    if (freezeFirstColumn) setFrozenColumnOffset(scrollRef.current?.scrollLeft ?? 0);
  }, [freezeFirstColumn, scrollRef]);
  const lastAppliedScrollRequestRef = useRef<string | null>(null);
  const controlledScrollTopRef = useRef<number | null>(null);
  const lastVisibleRangeRef = useRef<{
    key: string | number | undefined;
    range: DataTableVisibleRange;
  } | null>(null);
  const scrollTop = virtualize ? (scrollRef.current?.scrollTop ?? 0) : 0;
  const measuredViewportHeight = scrollRef.current?.viewport?.height;
  const tableWindow = useMemo(
    () => measurePerf(
      "data-table.visible-rows",
      () => resolveDataTableVisibleWindow({
        appViewportHeight: appViewport.height,
        items,
        measuredViewportHeight,
        overscan,
        scrollTop,
        virtualize,
      }),
      {
        itemCount: items.length,
        measuredViewportHeight,
        overscan,
        scrollTop,
        virtualize,
      },
    ),
    [
      appViewport.height,
      items,
      items.length,
      measuredViewportHeight,
      overscan,
      scrollTop,
      scrollVersion,
      virtualize,
    ],
  );
  const { endIndex, startIndex, viewportHeight, visibleItems } = tableWindow;
  const tableWidth = useMemo(
    () => getTableWidth(columns, columnGap, horizontalPadding),
    [columnGap, columns, horizontalPadding],
  );
  const {
    contentWidth: measuredContentWidth,
    viewportWidth: measuredViewportWidth,
    measureContentWidth,
  } = useMeasuredTableContentWidth(tableWidth, headerScrollRef, scrollRef);
  const horizontalScrollbarVisible = showHorizontalScrollbar
    && hasMeaningfulTableHorizontalOverflow(tableWidth, measuredViewportWidth, columnGap);
  const contentWidth = fillAvailableWidth ? measuredContentWidth : tableWidth;
  const displayColumns = useMemo(
    () => expandTableColumns(columns, contentWidth, columnGap, horizontalPadding),
    [columnGap, columns, contentWidth, horizontalPadding],
  );
  const columnStarts = useMemo(
    () => tableColumnStarts(displayColumns, columnGap),
    [columnGap, displayColumns],
  );
  const emitVisibleRange = useCallback(() => {
    if (!onVisibleRangeChange) return;
    const scrollBox = scrollRef.current;
    const range = resolveDataTableVisibleRange({
      itemCount: items.length,
      rowSize: 1,
      scrollOffset: scrollBox?.scrollTop ?? scrollTop,
      viewportSize: scrollBox?.viewport?.height ?? viewportHeight,
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
  }, [items.length, onVisibleRangeChange, scrollRef, scrollTop, viewportHeight, visibleRangeKey]);
  const handleRowMouseDown =
    useDoubleClickActivation<DataTableRowPointerTarget<T>>({
      onSelect: ({ item, index }) => {
        onSelect(item, index);
      },
      onActivate: onActivate
        ? ({ item, index }) => {
            onActivate(item, index);
          }
        : undefined,
    });

  const handleBodyScrollActivity = useCallback(() => {
    if (virtualize) {
      setScrollVersion((current) => current + 1);
    }
    const controlledTop = controlledScrollTopRef.current;
    controlledScrollTopRef.current = null;
    const source = controlledTop !== null && scrollRef.current?.scrollTop === controlledTop
      ? "programmatic"
      : "user";
    onBodyScrollActivity(source);
    emitVisibleRange();
    nativeRenderer.requestRender();
  }, [emitVisibleRange, nativeRenderer, onBodyScrollActivity, scrollRef, virtualize]);
  const syncHorizontalScroll = useCallback(() => {
    syncHeaderScroll();
    if (freezeFirstColumn) setFrozenColumnOffset(scrollRef.current?.scrollLeft ?? 0);
  }, [freezeFirstColumn, scrollRef, syncHeaderScroll]);
  useScrollBoxScrollActivity({
    scrollRef,
    onVerticalScroll: handleBodyScrollActivity,
    onHorizontalScroll: syncHorizontalScroll,
  });
  const syncBodyScroll = useCallback(() => {
    const header = headerScrollRef.current;
    const body = scrollRef.current;
    if (!header || !body || body.scrollLeft === header.scrollLeft) return;
    body.scrollLeft = header.scrollLeft;
    if (freezeFirstColumn) setFrozenColumnOffset(body.scrollLeft ?? 0);
    nativeRenderer.requestRender();
  }, [freezeFirstColumn, headerScrollRef, nativeRenderer, scrollRef]);
  useScrollBoxScrollActivity({
    scrollRef: headerScrollRef,
    onHorizontalScroll: syncBodyScroll,
  });
  const handleBodySizeChange = useCallback(() => {
    measureContentWidth();
    setScrollVersion((current) => current + 1);
    queueMicrotask(emitVisibleRange);
  }, [emitVisibleRange, measureContentWidth]);

  useEffect(() => observeScrollBoxContentSize(scrollRef.current, handleBodySizeChange), [handleBodySizeChange, scrollRef]);
  useEffect(() => observeScrollBoxViewportSize(scrollRef.current, handleBodySizeChange), [handleBodySizeChange, scrollRef]);

  useEffect(() => {
    emitVisibleRange();
    queueMicrotask(emitVisibleRange);
  }, [emitVisibleRange]);
  const focusPane = useCallback(() => {
    if (!paneInstanceId) return;
    dispatch({ type: "FOCUS_PANE", paneId: paneInstanceId });
  }, [dispatch, paneInstanceId]);

  const applyScrollToIndex = useCallback(() => {
    if (scrollToIndex == null) return true;
    if (items.length === 0) return false;
    const scrollBox = scrollRef.current;
    // An empty or unmeasured body clamps scrollTo to zero. Keep the request
    // pending until the rows and viewport have completed native layout.
    if (!scrollBox?.viewport
      || scrollBox.viewport.height <= 0
      || scrollBox.scrollHeight < items.length) return false;

    const targetIndex = Math.max(0, Math.min(scrollToIndex, items.length - 1));
    const visibleHeight = Math.max(
      1,
      Math.min(scrollBox.viewport.height, Math.ceil(appViewport.height)),
    );
    const currentTop = scrollBox.scrollTop;
    const nextTop = resolveDataTableScrollTop(
      targetIndex,
      currentTop,
      visibleHeight,
      items.length,
      scrollToIndexAlign,
    );

    if (nextTop === currentTop) return true;
    scrollBox.scrollTo(nextTop);
    controlledScrollTopRef.current = scrollBox.scrollTop;
    return scrollBox.scrollTop === nextTop;
  }, [
    appViewport.height,
    items.length,
    scrollRef,
    scrollToIndex,
    scrollToIndexAlign,
  ]);

  useEffect(() => {
    const header = headerScrollRef.current;
    if (header) {
      if (header.horizontalScrollBar) {
        header.horizontalScrollBar.visible = false;
      }
      if (!horizontalScrollbarVisible) {
        header.scrollLeft = 0;
      }
    }
    const body = scrollRef.current;
    if (body) {
      // Forcing a bar visible latches manual visibility, and the scroll box then
      // paints a full-length solid thumb whenever there is nothing to scroll.
      // Only the hidden side is forced; otherwise the scroll box decides from
      // its own content size.
      setScrollBarVisible(body.horizontalScrollBar, horizontalScrollbarVisible);
      if (body.viewport) {
        setScrollBarVisible(body.verticalScrollBar, items.length > body.viewport.height);
      }
      if (!horizontalScrollbarVisible) {
        body.scrollLeft = 0;
      }
    }
  }, [columns.length, headerScrollRef, horizontalScrollbarVisible, items.length, measuredViewportHeight, scrollRef]);

  useEffect(() => {
    if (items.length === 0) {
      lastAppliedScrollRequestRef.current = null;
      const body = scrollRef.current;
      if (body && body.scrollTop !== 0) {
        // Removing a scrolled dataset is a layout reset, not user navigation.
        // Reveal its loading state and let the next dataset center normally.
        body.scrollTo(0);
        controlledScrollTopRef.current = body.scrollTop;
      }
      return;
    }
    if (scrollToIndex == null) {
      lastAppliedScrollRequestRef.current = null;
      return;
    }

    const scrollRequestKey = [
      scrollToIndex,
      scrollToIndexVersion,
      scrollToIndexAlign,
      measuredViewportHeight ?? "pending",
    ].join(":");
    if (lastAppliedScrollRequestRef.current === scrollRequestKey) return;

    if (applyScrollToIndex()) {
      lastAppliedScrollRequestRef.current = scrollRequestKey;
      return;
    }
    // Body/content size events retry a pending request after measurement;
    // completed requests remain consumed while users scroll or rows append.
  }, [
    applyScrollToIndex,
    items.length,
    measuredViewportHeight,
    scrollRef,
    scrollToIndex,
    scrollToIndexAlign,
    scrollToIndexVersion,
    scrollVersion,
  ]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      width="100%"
      backgroundColor={colors.bg}
      overflow="hidden"
    >
      <ScrollBox
        id={headerScrollId}
        ref={headerScrollRef}
        width={measuredViewportWidth || "100%"}
        height={1}
        backgroundColor={colors.panel}
        scrollX={showHorizontalScrollbar}
        focusable={false}
        onSizeChange={measureContentWidth}
      >
        <Box
          flexDirection="row"
          height={1}
          {...tableContentWidthProps(contentWidth)}
          paddingX={horizontalPadding}
          backgroundColor={colors.panel}
        >
          {displayColumns.map((column, columnIndex) => {
            const frozen = freezeFirstColumn && columnIndex === 0;
            const columnStart = columnStarts[columnIndex] ?? 0;
            const inset = freezeFirstColumn && !frozen
              ? Math.min(column.width, Math.max(0, frozenColumnOffset + (displayColumns[0]?.width ?? 0) + columnGap - columnStart)) : 0;
            const isSorted = sortColumnId === column.id;
            const marker = sortDirection === "asc" ? "▲" : "▼";
            // An unlabeled column shows the bare marker, not a stray space before it.
            const indicator = isSorted ? column.label ? ` ${marker}` : marker : "";
            // A lead gap already separates this label from the next one, so a
            // right-aligned label keeps no blank of its own and sits flush
            // over its numbers.
            const hasNextLabel = columnIndex < displayColumns.length - 1
              && tableColumnLeadGap(displayColumns, columnIndex + 1, columnGap) === 0;
            const labelText = " ".repeat(inset) + (inset < column.width ? fitTableHeaderText(
              column.label + indicator,
              column.width - inset,
              column.align,
              hasNextLabel,
            ) : "");
            return (
              <Box
                key={column.id}
                width={column.width + columnGap + (frozen ? horizontalPadding : 0)}
                marginLeft={frozen ? -horizontalPadding : tableColumnLeadGap(displayColumns, columnIndex, columnGap)}
                position="relative"
                left={frozen ? frozenColumnOffset : undefined}
                zIndex={frozen ? 1 : undefined}
                backgroundColor={column.headerBackgroundColor ?? colors.panel}
                onMouseDown={(event: any) => {
                  focusPane();
                  onTableMouseDown?.(event);
                  if (!onHeaderClick) return;
                  event.preventDefault();
                  onHeaderClick(column.id);
                }}
              >
                <Text
                  attributes={TextAttributes.BOLD}
                  fg={isSorted ? colors.text : column.headerColor ?? colors.textDim}
                >
                  {frozen ? `${" ".repeat(horizontalPadding)}${labelText}${" ".repeat(columnGap)}` : labelText}
                </Text>
              </Box>
            );
          })}
        </Box>
      </ScrollBox>

      <ScrollBox
        id={bodyScrollId}
        ref={scrollRef}
        width="100%"
        flexGrow={1}
        flexBasis={0}
        backgroundColor={colors.bg}
        scrollX={showHorizontalScrollbar}
        scrollY
        focusable={false}
        onMouseDown={() => {
          focusPane();
          onTableMouseDown?.({});
        }}
        onSizeChange={handleBodySizeChange}
      >
        {items.length === 0 ? (
          emptyContent ?? (
            <Box width="100%" paddingX={1} paddingY={1}>
              <EmptyState title={emptyStateTitle} hint={emptyStateHint} />
            </Box>
          )
        ) : (
          <>
            {virtualize && startIndex > 0 && <Box height={startIndex} />}
            {measurePerf(
              "data-table.render-visible-rows",
              () => visibleItems.map((item, visibleIndex) => {
                const index = startIndex + visibleIndex;
                const itemKey = getItemKey(item, index);
                return (
                  <OpenTuiDataTableRow<T, C>
                    key={itemKey}
                    colors={colors}
                    columnGap={columnGap}
                    columnStarts={columnStarts}
                    contentWidth={contentWidth}
                    displayColumns={displayColumns}
                    focusPane={focusPane}
                    frozenColumnOffset={freezeFirstColumn ? frozenColumnOffset : undefined}
                    getRowBackgroundColor={getRowBackgroundColor}
                    handleRowMouseDown={handleRowMouseDown}
                    horizontalPadding={horizontalPadding}
                    index={index}
                    item={item}
                    itemKey={itemKey}
                    onRowContextMenu={onRowContextMenu}
                    onRowMouseDown={onRowMouseDown}
                    onTableMouseDown={onTableMouseDown}
                    renderCell={renderCell}
                    renderSectionHeader={renderSectionHeader}
                    rowContextMenuSurface={rowContextMenuSurface}
                    rowVersion={getRowVersion?.(item, index)}
                    selected={isSelected(item, index)}
                  />
                );
              }),
              {
                columnCount: displayColumns.length,
                endIndex,
                itemCount: items.length,
                measuredViewportHeight,
                paneId: paneInstanceId,
                startIndex,
                viewportHeight,
                visibleCount: visibleItems.length,
                virtualize,
              },
            )}
            {virtualize && endIndex < items.length && (
              <Box height={Math.max(items.length - endIndex, 0)} />
            )}
            {bodyAfter}
          </>
        )}
      </ScrollBox>
    </Box>
  );
}
