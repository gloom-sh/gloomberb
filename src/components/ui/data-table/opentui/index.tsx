import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, useNativeRenderer } from "../../../../ui";
import { hoverBg } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { useAppDispatch, usePaneInstance } from "../../../../state/app/context";
import { useViewport } from "../../../../react/input";
import { padTo } from "../../../../utils/format";
import { measurePerf } from "../../../../utils/perf-marks";
import { useDoubleClickActivation } from "../../../use-double-click-activation";
import { useScrollBoxScrollActivity } from "../../../table-view-shared";
import { EmptyState } from "../../status";
import {
  expandTableColumns,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
  tableContentWidthProps,
  useMeasuredTableContentWidth,
} from "../../table-layout";
import type {
  DataTableColumn,
  DataTableProps,
} from "../types";
import {
  resolveDataTableScrollTop,
  resolveDataTableVisibleWindow,
} from "./model";

interface DataTableRowPointerTarget<T> {
  item: T;
  index: number;
}

export function OpenTuiDataTable<T, C extends DataTableColumn = DataTableColumn>({
  columns,
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
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const paneInstanceId = usePaneInstance()?.instanceId ?? null;
  const appViewport = useViewport();
  const nativeRenderer = useNativeRenderer();
  const [scrollVersion, setScrollVersion] = useState(0);
  const lastAppliedScrollRequestRef = useRef<string | null>(null);
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
    onBodyScrollActivity();
    nativeRenderer.requestRender();
  }, [nativeRenderer, onBodyScrollActivity, virtualize]);
  useScrollBoxScrollActivity({
    scrollRef,
    onVerticalScroll: handleBodyScrollActivity,
    onHorizontalScroll: syncHeaderScroll,
  });
  const focusPane = useCallback(() => {
    if (!paneInstanceId) return;
    dispatch({ type: "FOCUS_PANE", paneId: paneInstanceId });
  }, [dispatch, paneInstanceId]);

  const applyScrollToIndex = useCallback(() => {
    if (scrollToIndex == null || items.length === 0) return true;
    const scrollBox = scrollRef.current;
    if (!scrollBox?.viewport) return false;

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
    if (scrollBox.scrollTop !== nextTop) return false;
    if (virtualize) {
      setScrollVersion((current) => current + 1);
    }
    syncHeaderScroll();
    return true;
  }, [
    appViewport.height,
    items.length,
    scrollRef,
    scrollToIndex,
    scrollToIndexAlign,
    syncHeaderScroll,
    virtualize,
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
      if (body.horizontalScrollBar) {
        body.horizontalScrollBar.visible = horizontalScrollbarVisible;
      }
      if (body.verticalScrollBar && body.viewport) {
        body.verticalScrollBar.visible = items.length > body.viewport.height;
      }
      if (!horizontalScrollbarVisible) {
        body.scrollLeft = 0;
      }
    }
  }, [columns.length, headerScrollRef, horizontalScrollbarVisible, items.length, measuredViewportHeight, scrollRef]);

  useEffect(() => {
    if (scrollToIndex == null) {
      lastAppliedScrollRequestRef.current = null;
      return;
    }

    const scrollRequestKey = [
      scrollToIndex,
      scrollToIndexVersion,
      measuredViewportHeight ?? "pending",
    ].join(":");
    if (lastAppliedScrollRequestRef.current === scrollRequestKey) return;

    if (applyScrollToIndex()) {
      lastAppliedScrollRequestRef.current = scrollRequestKey;
      return;
    }
    let cancelled = false;
    const retry = () => {
      if (cancelled) return;
      if (applyScrollToIndex()) {
        lastAppliedScrollRequestRef.current = scrollRequestKey;
      }
    };
    process.nextTick(retry);
    return () => {
      cancelled = true;
    };
  }, [
    applyScrollToIndex,
    measuredViewportHeight,
    scrollToIndex,
    scrollToIndexVersion,
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
        width="100%"
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
          {displayColumns.map((column) => {
            const isSorted = sortColumnId === column.id;
            const indicator = isSorted
              ? sortDirection === "asc"
                ? " ▲"
                : " ▼"
              : "";
            const labelText = padTo(
              column.label + indicator,
              column.width,
              column.align,
            );
            return (
              <Box
                key={column.id}
                width={column.width + columnGap}
                backgroundColor={column.headerBackgroundColor ?? colors.panel}
                onMouseDown={(event: any) => {
                  focusPane();
                  onTableMouseDown?.(event);
                  event.preventDefault();
                  onHeaderClick(column.id);
                }}
              >
                <Text
                  attributes={TextAttributes.BOLD}
                  fg={isSorted ? colors.text : column.headerColor ?? colors.textDim}
                >
                  {labelText}
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
        onSizeChange={measureContentWidth}
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
                const sectionHeader = renderSectionHeader?.(item, index) ?? null;

                if (sectionHeader) {
                  return (
                    <Box
                      key={getItemKey(item, index)}
                      flexDirection="row"
                      height={1}
                      {...tableContentWidthProps(contentWidth)}
                      paddingX={horizontalPadding}
                      backgroundColor={sectionHeader.backgroundColor ?? colors.bg}
                      onMouseDown={(event: any) => {
                        focusPane();
                        onTableMouseDown?.(event);
                        event.preventDefault();
                      }}
                    >
                      <Text
                        attributes={sectionHeader.attributes ?? TextAttributes.BOLD}
                        fg={sectionHeader.color ?? colors.textBright}
                      >
                        {sectionHeader.text}
                      </Text>
                    </Box>
                  );
                }

                const selected = isSelected(item, index);
                const rowState = { selected };
                const rowBackgroundColor = getRowBackgroundColor?.(
                  item,
                  index,
                  rowState,
                );
                const rowBg = selected
                  ? colors.selected
                  : rowBackgroundColor ?? colors.bg;
                const rowHoverBg = selected ? undefined : hoverBg(colors);

                return (
                  <Box
                    key={getItemKey(item, index)}
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
                      if (onRowMouseDown?.(item, index, event) === true) {
                        return;
                      }
                      event.preventDefault();
                      handleRowMouseDown(getItemKey(item, index), {
                        item,
                        index,
                      }, event);
                    }}
                    onContextMenu={(event: any) => {
                      focusPane();
                      onRowContextMenu?.(item, index, event);
                    }}
                  >
                    {displayColumns.map((column) => {
                      const cell = renderCell(item, column, index, rowState);
                      return (
                        <Box
                          key={column.id}
                          width={column.width + columnGap}
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
                            handleRowMouseDown(getItemKey(item, index), {
                              item,
                              index,
                            }, event);
                          }}
                        >
                          {cell.content !== undefined ? (
                            cell.content
                          ) : (
                            <Text
                              attributes={cell.attributes ?? TextAttributes.NONE}
                              fg={
                                cell.color ??
                                (selected ? colors.selectedText : colors.text)
                              }
                            >
                              {padTo(cell.text, column.width, column.align)}
                            </Text>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
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
