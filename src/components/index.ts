export { MarketBoardStack, type MarketBoardRow, type MarketBoardStackProps } from "./market-board";

export { PriceSelectorDialog } from "./price-selector-dialog";
export { StaticChartSurface } from "./chart/static";
export { CurveSurface, curveGhostColors, curveSlope, historyStatistics } from "./chart/curve";
export type { CurveSurfaceProps, CurveSlopeReadout, CurvePoint, CurveSeries, HistoryObservation, HistoryStatistics } from "./chart/curve";
export type { StaticChartOverlay } from "./chart/static/chart-surface";
// The time-series chart: one or more panels of resolved series with axes,
// a cursor, and range selection. Ticker overview, polls, econ statistics,
// and prediction markets all draw with it.
export { CompositeChart, pricePointsToResolvedSeries } from "./chart/composite";
export type {
  CompositeAxisDomain,
  CompositeAxisSide,
  CompositeChartColors,
  CompositeChartProps,
  CompositeChartScene,
  CompositeCursorValue,
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
  PricePointsToResolvedSeriesOptions,
} from "./chart/composite";
// A static chart's callers project their own points and pick a palette; these
// are the same helpers the host's gauges and sparklines use to do that.
export type { ProjectedChartPoint } from "./chart/core/data";
export { resolveChartPalette } from "./chart/core/palette";
export {
  buildMetricTreemapNavigationTiles,
  findMetricTreemapNeighbor,
  MetricTreemapSurface,
  type MetricTreemapDirection,
  type MetricTreemapItem,
} from "./metric-treemap";
export { SpeedometerGauge } from "./speedometer-gauge";
export type { SpeedometerSegment } from "./speedometer-gauge";
export { TickerListTableView, useTickerRowPaneMenu } from "./ticker/list-table-view";
export type { TickerListVisibleRange } from "./ticker/list-table-view";
// What `TickerListTableView` puts in each configured column, and the value it
// sorts on. A pane that shows the user's own column set has to read them the
// same way or its rows disagree with the portfolio's.
export { getColumnValue, getSortValue } from "../plugins/builtin/portfolio-list/column-values";
export type { ColumnContext } from "../plugins/builtin/portfolio-list/column-values";
export { TickerBadgeList } from "./ticker/badge/list";
export { TickerBadgeText } from "./ticker/badge/text";
// One `useInlineTickers` catalog entry in running text. With `badgeQuotes`
// the badge follows its own symbol's quote, so a tick re-renders the chip
// rather than the document around it.
export { InlineTickerBadge } from "./ticker/badge";
export type { InlineTickerBadgeProps } from "./ticker/badge";
export { InputSearchBar } from "./input-search-bar";
export { isTableScrollNearEnd, useTableLoadMore } from "./table-view-shared";
export { DataTableView } from "./data-table/view";
export type {
  DataTableKeyEvent,
  DataTableRootKeyContext,
  DataTableSelectionChangeReason,
} from "./data-table/view";
// Grouped table rows: header rows with a count, skipped by selection and export.
export {
  buildSectionedRows,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  renderSectionedRowHeader,
  sectionedRowsHeight,
} from "./data-table/sections";
export type { SectionedRow, TableSection } from "./data-table/sections";
export { DataTableStackView } from "./data-table/stack-view";
// Row cells that cost real work to derive (formatting, unit resolution,
// per-row lookups) recomputed only when that row's data version changes, so a
// table re-render on selection or scroll does not redo all of it.
export { createRowValueCache } from "./ui/row-value-cache";
export type { RowValueCache } from "./ui/row-value-cache";
export { FeedDataTableStackView } from "./feed-data-table/stack-view";
export type { FeedDataTableItem } from "./feed-data-table/stack-view";
export { activeStackIndex, sortStackItems } from "./feed-stack-controller";
export type { StackSortPreference } from "./feed-stack-controller";
export { PaneFooterScope, usePaneFooter, usePaneMenuItems } from "./layout/pane/footer";
export { NestedPaneTabs, usePaneHeaderTabs } from "./layout/pane/header-tabs";
export type { PaneHeaderTabsRegistration } from "./layout/pane/header-tabs";
// The common footer shapes on top of `usePaneFooter`: a status segment that
// changes with loading/error state, and one that also carries a link.
export { usePaneStatusFooter, usePaneStatusLinkFooter } from "../plugins/builtin/shared/pane-footer";
export { usePaneNoticeFooter, type UsePaneNoticeFooterOptions } from "./use-pane-notice-footer";
export { loadingErrorFooterInfo } from "../plugins/builtin/shared/table-pane";
export type { PaneFooterPressEvent, PaneFooterSegment, PaneHint } from "./layout/pane/footer";
export {
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
  readStoredPaneSidebarWidth,
  shouldShowPaneSidebar,
} from "./layout/pane/sidebar";
export type {
  PaneSidebarActionRenderState,
  PaneSidebarRenderState,
  PaneSidebarResize,
  PaneSidebarRowRenderState,
} from "./layout/pane/sidebar";
export { useExternalLinkFooter } from "./use-external-link-footer";
// Markdown as the app renders it, for panes that show text written by someone
// else: a model's answer, a release note, a fetched article.
export { MarkdownText } from "./markdown-text";
export * from "./ui";
export { usePaneTicker } from "../state/app/context";
