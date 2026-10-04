import { useCallback, useMemo, useRef } from "react";
import type { AppRankPayload } from "../../../api-client/app-attention";
import { isAccessDenied } from "../../../api-client/errors";
import { ChartTableHeader, DataTableView, PaneStatusBody, QueryBar, useChartTableSelection, usePagedRows, usePaneStatusFooter, usePaneTabs, useTableLoadMore, type DataTableColumn } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { fetchAppRank, loadAppRank } from "./client";
import { attentionSeries, count, type AppFocus } from "./model";
import { useRemoteUiNode } from "../../../remote/semantic-tree";

type Point = AppRankPayload["rankHistory"][number];
const id = (point: Point) => `${point.revisionId}:${point.date}`;
const date = (point: Point) => new Date(point.date);
const columns: DataTableColumn[] = [
  { id: "date", label: "Date", width: 12, align: "left" },
  { id: "rank", label: "Rank", width: 9, align: "right" },
  { id: "rating", label: "Rating / 5", width: 12, align: "right" },
  { id: "ratingCount", label: "Ratings", width: 14, align: "right" },
  { id: "reviewCount", label: "Written reviews", width: 17, align: "right" },
  { id: "observedAt", label: "Observed (UTC)", width: 22, align: "left", flexGrow: 1 },
];
export function AppRankView({ focus, accessKey, width, height, focused }: { focus: AppFocus; accessKey: string; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const upgrade = useCloudUpgradeAction("apps-history");
  const key = `${focus.store}:${focus.appId}:${focus.country}:${focus.chart}`;
  const [days, setDays] = usePluginPaneState<string>(`apps-rank:${key}:days`, "90");
  const [openingTab] = usePaneSettingValue<string>("tab", "chart");
  const [tab, setTab] = usePluginPaneState<string>(`apps-rank:${key}:tab`, openingTab === "evidence" ? "evidence" : "chart");
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`apps-rank:${key}:selected`, null);
  const [snapshot] = usePaneSettingValue<AppRankPayload | null>("appRankSnapshot", null);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadAppRank(focus, accessKey, Number(days), force), [focus, accessKey, days, snapshot]);
  const resource = useAsyncResource(loader, { clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const loadPage = useCallback(async ({ offset, signal }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const payload = offset === 0 && data ? data : await fetchAppRank(focus, Number(days), offset, signal);
    return { rows: payload.rankHistory, hasMore: payload.page.nextOffset !== null, nextOffset: payload.page.nextOffset };
  }, [data, focus, days]);
  const pages = usePagedRows(data ? loadPage : null, { getId: id });
  const points = useMemo(() => [...pages.rows].sort((a, b) => b.date.localeCompare(a.date)), [pages.rows]);
  const selected = points.find((row) => id(row) === selectedId) ?? points[0];
  useRemoteUiNode({ role: "chart-data", label: "Rendered app rank history", getMetadata: () => ({ kind: "apps", version: 1, complete: !!data, ready: !!data, plottedValueCount: points.length, payload: data, tab, rowIds: points.map(id) }) });
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const more = useTableLoadMore(scroll, pages.hasMore, pages.loadMore);
  const selection = useChartTableSelection({ rows: points, getId: id, getDate: date, selectedId: selected ? id(selected) : null, onSelect: setSelected, focused });
  const series = useMemo(() => attentionSeries({ chart: { label: `${focus.name} rank`, unit: "rank", points: points.map((point) => ({ date: point.date, value: point.rank })) } }, colors.textBright), [points, focus.name, colors.textBright]);
  const { strip, rows: tabRows } = usePaneTabs({ tabs: [{ value: "chart", label: "Chart" }, { value: "evidence", label: "Evidence" }], activeValue: tab, onSelect: setTab, focused, dense: true, queryBarWidth: width });
  usePaneRefreshKey(() => { void resource.reload(); pages.reload(); }, { focused });
  usePaneStatusFooter({ registrationId: `apps-rank:${key}`, loading: resource.loading || pages.loadingMore, error: resource.error ?? pages.moreError?.message, stale: resource.data?.stale,
    info: [...(points[0] ? [{ id: "observed", parts: [{ text: `as of ${points[0].observedAt.slice(0, 10)}`, tone: "muted" as const }] }] : []), ...(data?.access === "preview" ? [{ id: "preview", parts: [{ text: "Pro preview", tone: "warning" as const }] }] : [])],
    hints: [...(selected ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(selected.sourceUrl) }] : []), ...(data?.access === "preview" ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : [])] });
  const tableColumns = tab === "evidence" ? [...columns, { id: "present", label: "In chart", width: 10, align: "left" as const }, { id: "sourceUpdatedAt", label: "Published (UTC)", width: 22, align: "left" as const }, { id: "revisionId", label: "Revision", width: 30, align: "left" as const }] : columns;
  return <Box flexDirection="column" width={width} height={height}>
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="app rank history">
      <DataTableView columns={tableColumns} items={points} sortColumnId="date" sortDirection="desc" getItemKey={id} rootWidth={width} rootHeight={height - tabRows} focused={focused}
        scrollRef={scroll} onBodyScrollActivity={more} selection={{ kind: "id", getId: id, selectedId: selected ? id(selected) : null, onChange: setSelected }}
        onActivate={(point) => void host.openExternal(point.sourceUrl)}
        rootBefore={<ChartTableHeader width={width} height={height - tabRows} tableRows={points.length} tableColumns={tableColumns}
          query={<QueryBar width={width} meta={`${focus.country} · ${focus.chart}`} filters={[{ id: "days", label: "Window", value: days, options: ["30", "90", "365", "730"].map((value) => ({ value, label: `${value}D` })), onChange: setDays }]} />}
          figures={points[0] ? [{ label: "Rank", value: count(points[0].rank) }, { label: "Rating", value: points[0].rating?.toFixed(2) ?? "--", detail: "/ 5" }, { label: "Ratings", value: count(points[0].ratingCount) }] : []}
          chart={tab === "chart" ? { series, ...selection, formatValue: (value) => `#${count(value)}`, empty: series.length ? undefined : "Collecting rank history", remoteKind: "app-rank-history" } : null} />}
        renderCell={(point, column) => { const value = point[column.id as keyof Point]; return { text: value == null ? "--" : column.id === "rating" ? Number(value).toFixed(2) : typeof value === "number" ? count(value) : String(value), value: typeof value === "boolean" ? String(value) : value }; }}
        emptyStateTitle="No observations for this app and chart yet." selectedTextOverridesCellColor showHorizontalScrollbar />
    </PaneStatusBody>
  </Box>;
}
