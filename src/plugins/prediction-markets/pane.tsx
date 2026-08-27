import { Box, Input, Text } from "../../ui";
import { useCallback, useMemo, useRef } from "react";
import {
  DataTableStackView,
  Spinner,
  Tabs,
  usePaneFooter,
  useTableLoadMore,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../components";
import { createRowValueCache } from "../../components/ui/row-value-cache";
import type { PaneProps } from "../../types/plugin";
import { colors } from "../../theme/colors";
import { PREDICTION_CATEGORY_OPTIONS } from "./categories";
import { usePredictionMarketsController } from "./controller";
import { PredictionMarketDetailPane } from "./detail/pane";
import { resolvePredictionDetailTitle } from "./detail/shared";
import { getPredictionColumnValue } from "./metrics";
import { BROWSE_TABS, VENUE_TABS } from "./navigation";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../utils/search-focus-navigation";
import type {
  PredictionBrowseTab,
  PredictionCategoryId,
  PredictionColumnDef,
  PredictionListRow,
} from "./types";

const PREDICTION_CELL_CACHE_SIZE = 12_000;
const RELATIVE_TIME_CELL_BUCKET_MS = 60_000;

const predictionRowVersions = new WeakMap<object, number>();
let nextPredictionRowVersion = 1;

function predictionRowVersion(row: PredictionListRow): number {
  const existing = predictionRowVersions.get(row);
  if (existing != null) return existing;
  const next = nextPredictionRowVersion;
  nextPredictionRowVersion += 1;
  predictionRowVersions.set(row, next);
  return next;
}

function predictionCellVersion(
  row: PredictionListRow,
  column: PredictionColumnDef,
  watchlisted: boolean,
  relativeTimeBucket: number,
): string {
  return [
    predictionRowVersion(row),
    column.id,
    watchlisted ? 1 : 0,
    column.id === "ends" || column.id === "updated" ? relativeTimeBucket : 0,
  ].join("|");
}

export function PredictionMarketsPane({ focused, width, height }: PaneProps) {
  const controller = usePredictionMarketsController({ focused });
  const cellCacheRef = useRef(
    createRowValueCache<string, ReturnType<typeof getPredictionColumnValue>>(
      PREDICTION_CELL_CACHE_SIZE,
    ),
  );
  const relativeTimeBucket = Math.floor(Date.now() / RELATIVE_TIME_CELL_BUCKET_MS);
  const watchlistedRowKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of controller.visibleRows) {
      if (row.watchMarketKeys.some((marketKey) => controller.watchlistSet.has(marketKey))) {
        keys.add(row.key);
      }
    }
    return keys;
  }, [controller.visibleRows, controller.watchlistSet]);
  const catalogStatusColor =
    controller.catalogStatus?.tone === "danger"
      ? colors.negative
      : colors.borderFocused;
  const rowsLoading =
    controller.visibleRows.length === 0 &&
    (controller.catalogLoadCount > 0 || controller.searchLoading);
  const detailTitle = resolvePredictionDetailTitle({
    detail: controller.detail,
    selectedRow: controller.selectedRow,
    selectedSummary: controller.selectedSummary,
  });
  usePaneFooter("prediction-markets", () => {
    if (controller.detailOpen) return null;
    return {
      info: [
        ...(controller.searchQuery.trim() ? [{ id: "search", parts: [{ text: `search: ${controller.searchQuery.trim()}`, tone: "value" as const }] }] : []),
        ...(controller.searchLoading ? [{ id: "search-loading", parts: [{ text: "searching", tone: "muted" as const }] }] : []),
        ...(controller.catalogStatus ? [{
          id: "catalog",
          parts: [{ text: controller.catalogStatus.message, tone: controller.catalogStatus.tone === "danger" ? "warning" as const : "muted" as const, color: catalogStatusColor }],
        }] : []),
      ],
      hints: [
        { id: "search", key: "/", label: "search", onPress: controller.actions.focusSearch },
        { id: "watch", key: "w", label: "atch", onPress: controller.selectedRow ? () => controller.actions.toggleWatchlist(controller.selectedRow!) : undefined, disabled: !controller.selectedRow },
        {
          id: "browse",
          key: "1-4",
          label: "browse",
          onPress: () => {
            const index = BROWSE_TABS.findIndex((tab) => tab.value === controller.browseTab);
            controller.actions.selectBrowseTab(BROWSE_TABS[(index + 1) % BROWSE_TABS.length]!.value as PredictionBrowseTab);
          },
        },
      ],
    };
  }, [
    catalogStatusColor,
    controller.browseTab,
    controller.catalogStatus?.message,
    controller.catalogStatus?.tone,
    controller.detailOpen,
    controller.searchLoading,
    controller.searchQuery,
    controller.selectedRow,
  ]);

  const browseControls = (
    <>
      {!controller.paneSettings.hideTabs ? (
        <Tabs
          tabs={VENUE_TABS.map((tab) => ({
            label: tab.label,
            value: tab.value,
          }))}
          activeValue={controller.effectiveVenueScope}
          onSelect={controller.actions.setVenue}
          compact
        />
      ) : null}

      <Box flexDirection="row" height={1} paddingX={1} gap={2}>
        <Box
          flexDirection="row"
          onMouseDown={controller.actions.focusSearch}
          width={Math.max(18, Math.floor(width * 0.32))}
        >
          <Text fg={colors.textDim}>{controller.searchFocused ? "?" : "/"}</Text>
          <Box width={1} />
          {controller.searchFocused ? (
            <Input
              ref={controller.searchInputRef}
              value={controller.searchQuery}
              focused={focused}
              placeholder="search markets"
              placeholderColor={colors.textDim}
              textColor={colors.text}
              backgroundColor={colors.panel}
              flexGrow={1}
              onInput={controller.actions.setSearchQuery}
              onChange={controller.actions.setSearchQuery}
              onSubmit={controller.actions.blurSearch}
            />
          ) : (
            <Box flexGrow={1}>
              <Text
                fg={
                  controller.searchQuery.trim().length > 0
                    ? colors.text
                    : colors.textDim
                }
              >
                {controller.searchQuery.trim().length > 0
                  ? controller.searchQuery
                  : "search markets"}
              </Text>
            </Box>
          )}
        </Box>

        <Box flexGrow={1}>
          <Tabs
            tabs={BROWSE_TABS.map((tab) => ({
              label: tab.label,
              value: tab.value,
            }))}
            activeValue={controller.browseTab}
            onSelect={(value) =>
              controller.actions.selectBrowseTab(value as PredictionBrowseTab)
            }
            compact
          />
        </Box>
      </Box>

      {PREDICTION_CATEGORY_OPTIONS.length > 1 ? (
        <Box height={1} paddingX={1}>
          <Tabs
            tabs={PREDICTION_CATEGORY_OPTIONS.map((category) => ({
              label: category.label,
              value: category.id,
            }))}
            activeValue={controller.categoryId}
            onSelect={(value) =>
              controller.actions.selectCategory(value as PredictionCategoryId)
            }
            compact
            variant="bare"
          />
        </Box>
      ) : null}

    </>
  );

  const renderCell = useCallback((
    row: PredictionListRow,
    column: PredictionColumnDef,
  ) => {
    const watchlisted = watchlistedRowKeys.has(row.key);
    const value = cellCacheRef.current.get(
      `${row.key}:${column.id}`,
      predictionCellVersion(row, column, watchlisted, relativeTimeBucket),
      () => getPredictionColumnValue(column, row, watchlisted),
    );
    if (column.id === "watch") {
      return {
        text: value.text,
        color: value.color,
        onMouseDown: (event: any) => {
          event.preventDefault();
          event.stopPropagation?.();
          controller.actions.toggleWatchlist(row);
        },
      };
    }
    return {
      text: value.text,
      color: value.color,
    };
  }, [
    controller.actions.toggleWatchlist,
    relativeTimeBucket,
    watchlistedRowKeys,
  ]);

  const onCatalogScroll = useTableLoadMore(
    controller.scrollRef,
    controller.catalogHasMore && !controller.catalogLoadingMore && !controller.detailOpen,
    () => { void controller.actions.loadMoreCatalog(); },
  );

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      controller.actions.focusSearch();
      return true;
    }
    return false;
  }, [controller.actions.focusSearch]);

  const detailContent =
    controller.selectedSummary && controller.selectedRow ? (
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        width={width}
        height={Math.max(height - 1, 1)}
        paddingX={1}
        overflow="hidden"
        backgroundColor={colors.panel}
      >
        <PredictionMarketDetailPane
          detail={controller.detail}
          detailError={controller.detailError}
          detailLoadCount={controller.detailLoadCount}
          detailTab={controller.detailTab}
          detailWidth={Math.max(width - 2, 24)}
          focused={focused && controller.detailOpen}
          height={Math.max(height - 1, 1)}
          historyRange={controller.historyRange}
          onDetailTabChange={controller.actions.setDetailTab}
          onHistoryRangeChange={controller.actions.setHistoryRange}
          onSelectMarket={controller.actions.selectMarket}
          scrollRef={controller.detailScrollRef}
          selectedRow={controller.selectedRow}
          selectedSummary={controller.selectedSummary}
        />
      </Box>
    ) : (
      <Box flexGrow={1} backgroundColor={colors.panel} />
    );

  return (
    <DataTableStackView<PredictionListRow, PredictionColumnDef>
      focused={focused}
      keyboardNavigation={!controller.searchFocused}
      detailOpen={controller.detailOpen && !!controller.selectedSummary}
      onBack={controller.actions.closeDetail}
      detailContent={detailContent}
      detailTitle={detailTitle}
      rootBefore={browseControls}
      rootWidth={width}
      rootHeight={height}
      rootBackgroundColor={colors.panel}
      selection={{
        kind: "id",
        selectedId: controller.selectedRow?.key ?? null,
        getId: (row) => row.key,
        onChange: (key, _row, _index, reason) =>
          controller.actions.setBrowseSelection(key, {
            debounceDetail: reason === "keyboard",
          }),
      }}
      onActivate={(row) =>
        controller.actions.openSelectedRow(row.key)}
      onRootKeyDown={handleRootKeyDown}
      columns={controller.visibleColumns}
      items={controller.visibleRows}
      sortColumnId={controller.sortPreference.columnId}
      sortDirection={controller.sortPreference.direction}
      onHeaderClick={controller.actions.handleSortHeaderClick}
      headerScrollRef={controller.headerScrollRef}
      scrollRef={controller.scrollRef}
      getItemKey={(row) => row.key}
      virtualize
      onBodyScrollActivity={onCatalogScroll}
      renderCell={renderCell}
      emptyContent={
        rowsLoading ? (
          <Box width="100%" paddingX={1} paddingY={1}>
            <Spinner
              label={
                controller.searchQuery.trim().length > 0
                  ? "Searching markets..."
                  : "Loading markets..."
              }
            />
          </Box>
        ) : undefined
      }
      emptyStateTitle="No markets matched."
      emptyStateHint="Change the venue, browse tab, or search query."
    />
  );
}
