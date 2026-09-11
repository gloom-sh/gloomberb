
export { PriceSelectorDialog } from "./price-selector-dialog";
export { StaticChartSurface } from "./chart/static";
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
export { TickerListTableView } from "./ticker/list-table-view";
export type { TickerListVisibleRange } from "./ticker/list-table-view";
export { TickerBadgeList } from "./ticker/badge/list";
export { TickerBadgeText } from "./ticker/badge/text";
export { InputSearchBar } from "./input-search-bar";
export { isTableScrollNearEnd, useTableLoadMore } from "./table-view-shared";
export { DataTableView } from "./data-table/view";
export type {
  DataTableKeyEvent,
  DataTableRootKeyContext,
  DataTableSelectionChangeReason,
} from "./data-table/view";
export { DataTableStackView } from "./data-table/stack-view";
export { FeedDataTableStackView } from "./feed-data-table/stack-view";
export type { FeedDataTableItem } from "./feed-data-table/stack-view";
export { activeStackIndex, sortStackItems } from "./feed-stack-controller";
export type { StackSortPreference } from "./feed-stack-controller";
export { PaneFooterScope, usePaneFooter } from "./layout/pane/footer";
// The common footer shapes on top of `usePaneFooter`: a status segment that
// changes with loading/error state, and one that also carries a link.
export { usePaneStatusFooter, usePaneStatusLinkFooter } from "../plugins/builtin/shared/pane-footer";
export { loadingErrorFooterInfo } from "../plugins/builtin/shared/table-pane";
export type { PaneFooterPressEvent, PaneFooterSegment, PaneHint } from "./layout/pane/footer";
export {
  getPaneSidebarWidth,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
  shouldShowPaneSidebar,
} from "./layout/pane/sidebar";
export type {
  PaneSidebarActionRenderState,
  PaneSidebarRenderState,
  PaneSidebarRowRenderState,
} from "./layout/pane/sidebar";
export { useExternalLinkFooter } from "./use-external-link-footer";
export * from "./ui";
export { usePaneTicker } from "../state/app/context";
