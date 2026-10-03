import { useCallback, useMemo } from "react";
import type { GpuBoardRow, GpuObservation } from "../../../api-client/gpu";
import { ChartTableHeader, DataTableView, PaneStatusBody, usePaneNoticeFooter, usePaneStatusFooter, type DataTableColumn } from "../../../components";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { SeriesListDetail, useSeriesList } from "../shared/series-list-detail";
import { loadGpuEvents, loadGpuHistory } from "./client";
import { gpuBasisLabel, gpuChange, gpuHistorySeries, gpuMatches, gpuPrice, gpuRowId, gpuRows, gpuSeriesLabel, gpuTime } from "./model";

const BASES = [{ value: "all", label: "All bases" }, { value: "list", label: "List price" }, { value: "spot", label: "Provider-declared spot" },
  { value: "ask", label: "Ask" }, { value: "reserved", label: "Reserved" }];
const listColumns = (): DataTableColumn[] => [{ id: "series", label: "Series", width: 25, flexGrow: 1, align: "left" }, { id: "price", label: "$/GPU-hr", width: 10, align: "right" }];
const HISTORY_COLUMNS: DataTableColumn[] = [{ id: "date", label: "Observed (UTC)", width: 18, flexGrow: 1, align: "left" },
  { id: "price", label: "$/GPU-hr", width: 10, align: "right" }, { id: "change", label: "Change", width: 9, align: "right" }];

function HistoryDetail({ row, width, height, focused, refreshVersion }: { row: GpuBoardRow; width: number; height: number; focused: boolean; refreshVersion: number }) {
  const colors = useThemeColors();
  const loader = useCallback(async (force: boolean) => {
    const [history, events] = await Promise.all([loadGpuHistory(row.id, force || refreshVersion > 0), loadGpuEvents(row.gpuModel, force || refreshVersion > 0)]);
    return { history, events };
  }, [row.id, row.gpuModel, refreshVersion]);
  const resource = useAsyncResource(loader, { keepPreviousData: true });
  useAutoRefresh(resource.updatedAt, resource.load);
  const points = resource.data?.history.payload.points ?? [];
  const events = resource.data?.events.payload.events ?? [];
  const series = useMemo(() => gpuHistorySeries(row, points, events, colors.textBright, colors.warning), [row, points, events, colors]);
  const records = useMemo(() => [...points].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).map((point, index, all) => ({
    ...point, change: index ? (point.pricePerGpuHr / all[index - 1]!.pricePerGpuHr - 1) * 100 : null,
  })).reverse(), [points]);
  usePaneStatusFooter({ registrationId: "gpu:history", loading: resource.loading, stale: resource.data?.history.stale,
    error: resource.error, info: points.length ? [{ id: "start", parts: [{ text: `history since ${points[0]!.observedAt.slice(0, 10)}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "gpu:history-notice", focused, notices: [resource.data?.history.refreshError, resource.data?.events.refreshError].filter((value): value is string => !!value) });
  const stats = row.stats;
  const figures = stats ? [
    { id: "providers", label: "Sample", value: String(stats.n), detail: row.providerClass === "aggregate" ? "providers" : "offers / regions" },
    { id: "min", label: "Raw low $/GPU-hr", value: gpuPrice(stats.min) },
    { id: "max", label: "Raw high $/GPU-hr", value: gpuPrice(stats.max) },
    ...(stats.p25 !== undefined ? [{ id: "p25", label: "Ask p25", value: gpuPrice(stats.p25) }, { id: "p75", label: "Ask p75", value: gpuPrice(stats.p75) }] : []),
  ] : [];
  return <PaneStatusBody loading={resource.loading && !resource.data} error={!resource.data ? resource.error : null} subject="GPU price history">
    <DataTableView columns={HISTORY_COLUMNS} items={records} rootWidth={width} rootHeight={height} focused={false}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={records.length} tableColumns={HISTORY_COLUMNS} figures={figures}
        chart={resource.error ? null : { series, formatValue: (value) => `$${gpuPrice(value)}`, remoteKind: "gpu-rental-history",
          loading: resource.loading && !resource.data, empty: series.length ? undefined : "History is accumulating from the first observation." }} />}
      selection={{ kind: "none" }} getItemKey={(point) => point.observedAt} sortColumnId={null} sortDirection="desc"
      renderCell={(point, column) => column.id === "date" ? { text: gpuTime(point.observedAt, true), value: point.observedAt }
        : column.id === "price" ? { text: gpuPrice(point.pricePerGpuHr), value: point.pricePerGpuHr }
          : { text: gpuChange(point.change), value: point.change }} emptyStateTitle="No observations for this series yet." />
  </PaneStatusBody>;
}

export function GpuHistory({ rows, selectedId, onSelect, initialModel, reloadBoard, width, height, focused }: {
  rows: GpuBoardRow[]; selectedId: string; onSelect: (id: string) => void; initialModel: string;
  reloadBoard: () => void; width: number; height: number; focused: boolean;
}) {
  const [basis, setBasis] = usePluginPaneState<string>("historyBasis", "all");
  const [refreshVersion, setRefreshVersion] = usePluginPaneState<number>("historyRefresh", 0);
  const ordered = useMemo(() => gpuRows(rows, "", basis), [rows, basis]);
  const initial = ordered.find((row) => row.gpuModel === initialModel && row.providerClass === "aggregate") ?? ordered[0];
  const refresh = useCallback(() => { reloadBoard(); setRefreshVersion(refreshVersion + 1); }, [reloadBoard, refreshVersion, setRefreshVersion]);
  const list = useSeriesList({ focused, items: ordered, getId: gpuRowId, matchesQuery: gpuMatches,
    selectedId: selectedId || initial?.id || "", onSelect, reload: refresh,
    range: { value: basis, options: BASES, onChange: setBasis } });
  return <SeriesListDetail list={list} width={width} height={height} focused={focused} listWidth={64}
    searchPlaceholder="GPU, cloud or aggregate" columns={listColumns} rows={list.visible} getRowId={gpuRowId}
    renderCell={(row, column) => column.id === "price" ? { text: gpuPrice(row.pricePerGpuHr), value: row.pricePerGpuHr }
      : { text: gpuSeriesLabel(row, true) }} emptyStateTitle="No series match."
    renderDetail={(size) => list.selected ? <HistoryDetail key={list.selected.id} row={list.selected} refreshVersion={refreshVersion} {...size} />
      : <PaneStatusBody empty emptyTitle={`No ${gpuBasisLabel(basis === "all" ? "list" : basis as GpuObservation["basis"])} series yet.`} />} />;
}
