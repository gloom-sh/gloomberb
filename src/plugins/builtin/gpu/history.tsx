import { useCallback, useMemo } from "react";
import type { GpuBasis, GpuBoardRow } from "../../../api-client/gpu";
import {
  buildSectionedRows, ChartTableHeader, DataTableView, EMPTY_TABLE_CELL, isSectionedItemRow, PaneStatusBody, renderSectionedRowHeader,
  usePaneNoticeFooter, usePaneStatusFooter, type DataTableCell, type DataTableColumn, type SectionedRow, type StatItem,
} from "../../../components";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../../ui";
import { SeriesListDetail, useSeriesList } from "../shared/series-list-detail";
import { loadGpuHistory } from "./client";
import {
  GPU_MODELS, gpuBasisLabel, gpuBoardSections, gpuChange, gpuChangeColor, gpuHeadline, gpuHistoryChart, gpuHistoryViewport, gpuProvenanceLabel, gpuMatches, gpuPricePeriods, gpuPrice, gpuShortSource,
  gpuTime, gpuVariant, type GpuPricePeriod,
} from "./model";

const BASES = [{ value: "all", label: "All bases" }, { value: "list", label: "List price" }, { value: "spot", label: "Provider-declared spot" },
  { value: "ask", label: "Ask" }, { value: "reserved", label: "Reserved" }];
type ListRow = SectionedRow<GpuBoardRow>;
const listRowId = (row: ListRow) => row.key;
const listColumns = (width: number): DataTableColumn[] => [
  // Gutters and the scrollbar take four cells beside the two columns.
  { id: "series", label: "Series", width: Math.max(16, width - 9 - 5), flexGrow: 1, align: "left" },
  { id: "price", label: "$/GPU-hr", width: 9, align: "right" },
];
const PERIOD_COLUMNS: DataTableColumn[] = [
  { id: "from", label: "From (UTC)", width: 14, align: "left" }, { id: "to", label: "To", width: 14, flexGrow: 1, align: "left" },
  { id: "price", label: "$/GPU-hr", width: 10, align: "right" }, { id: "change", label: "Change", width: 9, align: "right" },
  { id: "provenance", label: "Record", width: 10, align: "left" },
];
/** The selected series and the medians it is read against; never the whole board. */
const MAX_PLOTTED = 5;

function HistoryDetail({ row, peers, width, height, refreshVersion }: {
  row: GpuBoardRow; peers: readonly GpuBoardRow[]; width: number; height: number; refreshVersion: number;
}) {
  const colors = useThemeColors();
  const plotted = useMemo(() => [row, ...peers.filter((peer) => peer.id !== row.id && peer.basis === row.basis && gpuHeadline(peer))].slice(0, MAX_PLOTTED), [row, peers]);
  const ids = plotted.map((entry) => entry.id).join("\n");
  const loader = useCallback(async (force: boolean) => {
    const refresh = force || refreshVersion > 0;
    const histories = await Promise.all(ids.split("\n").map((id) => loadGpuHistory(id, refresh)));
    return { histories };
  }, [ids, row.gpuModel, refreshVersion]);
  const resource = useAsyncResource(loader, { keepPreviousData: true });
  useAutoRefresh(resource.updatedAt, resource.load);
  const points = useMemo(() => resource.data?.histories.flatMap((history) => history.payload.points) ?? [], [resource.data]);
  const chart = useMemo(() => gpuHistoryChart(plotted, points, { selected: colors.textBright, marker: colors.warning }), [plotted, points, colors]);
  const viewport = useMemo(() => gpuHistoryViewport(chart), [chart]);
  const own = useMemo(() => points.filter((point) => `${point.source}:${point.skuKey}` === row.id).sort((a, b) => a.observedAt.localeCompare(b.observedAt)), [points, row.id]);
  const periods = useMemo(() => gpuPricePeriods(own), [own]);
  const refreshErrors = resource.data?.histories.map((history) => history.refreshError) ?? [];
  usePaneStatusFooter({ registrationId: "gpu:history", loading: resource.loading, stale: resource.data?.histories.some((history) => history.stale),
    error: resource.error, info: own.length ? [{ id: "start", parts: [{ text: `history since ${gpuTime(own[0]!.observedAt, true)} UTC`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "gpu:history-notice", focused: true, notices: refreshErrors.filter((value): value is string => !!value) });
  const first = own[0], last = own.at(-1);
  const longHistory = first && last && Date.parse(last.observedAt) - Date.parse(first.observedAt) >= 365 * 86_400_000;
  const historyDate = (value: string) => longHistory ? value.slice(0, 10) : gpuTime(value, true);
  const stats = row.stats;
  const figures: StatItem[] = [
    { id: "latest", label: "$/GPU-hr", value: gpuPrice(row.pricePerGpuHr), detail: gpuTime(row.observedAt, true) },
    // A change needs the same three observations a line does; before that the history is still being collected.
    ...(first && last && own.length >= 3 ? [{ id: "change", label: "Change", value: gpuChange((last.pricePerGpuHr / first.pricePerGpuHr - 1) * 100),
      color: priceColor(last.pricePerGpuHr - first.pricePerGpuHr), detail: `since ${historyDate(first.observedAt)}` }] : []),
    ...(stats && stats.p25 !== undefined && stats.p75 !== undefined ? [{ id: "iqr", label: "Middle half", value: `${gpuPrice(stats.p25)}–${gpuPrice(stats.p75)}`, detail: `${stats.n} offers` }]
      : stats && stats.min !== stats.max ? [{ id: "range", label: "Range", value: `${gpuPrice(stats.min)}–${gpuPrice(stats.max)}`,
        detail: `${stats.n} ${row.providerClass === "aggregate" ? "providers" : "samples"}` }] : []),
  ];
  const renderCell = (period: GpuPricePeriod, column: DataTableColumn): DataTableCell => {
    if (column.id === "from") return { text: historyDate(period.from), value: period.from };
    if (column.id === "to") return { text: historyDate(period.to), value: period.to, color: colors.textDim };
    if (column.id === "provenance") return { text: gpuProvenanceLabel(period), color: period.provenance === "archive" ? colors.warning : colors.textDim };
    if (column.id === "price") return { text: gpuPrice(period.price), value: period.price, color: colors.textBright };
    return period.change == null ? { text: "", value: null } : { text: gpuChange(period.change), value: period.change, color: gpuChangeColor(period.change, colors) };
  };
  return <PaneStatusBody loading={resource.loading && !resource.data} error={!resource.data ? resource.error : null} subject="GPU price history">
    <DataTableView columns={PERIOD_COLUMNS} items={periods} rootWidth={width} rootHeight={height} focused={false}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={periods.length} tableColumns={PERIOD_COLUMNS} figures={figures}
        chart={resource.error && !resource.data ? null : { series: chart, viewport, formatValue: (value) => `$${gpuPrice(value)}`, remoteKind: "gpu-rental-history",
          loading: resource.loading && !resource.data,
          empty: resource.data?.histories.some((history) => history.payload.access?.locked) ? "Full history is available with Pro." : chart.length ? undefined : first ? `Collecting history since ${gpuTime(first.observedAt, true)} UTC` : "Collecting history" }} />}
      selection={{ kind: "none" }} getItemKey={(period) => period.from} sortColumnId={null} sortDirection="desc"
      renderCell={renderCell} emptyStateTitle="No observations for this series yet." />
  </PaneStatusBody>;
}

export function GpuHistory({ rows, model, setModel, selectedId, onSelect, reloadBoard, width, height, focused }: {
  rows: GpuBoardRow[]; model: string; setModel: (value: string) => void; selectedId: string; onSelect: (id: string) => void;
  reloadBoard: () => void; width: number; height: number; focused: boolean;
}) {
  const colors = useThemeColors();
  const [basis, setBasis] = usePluginPaneState<string>("historyBasis", "all");
  const [refreshVersion, setRefreshVersion] = usePluginPaneState<number>("historyRefresh", 0);
  // History always reads one model: the one picked on the board, else the selected series' model.
  const models = useMemo(() => [...new Set(rows.map((row) => row.gpuModel))].sort(), [rows]);
  const activeModel = model || rows.find((row) => row.id === selectedId)?.gpuModel || (models.includes("H100") ? "H100" : models[0] ?? GPU_MODELS[0]!);
  const sections = useMemo(() => gpuBoardSections(rows, activeModel).filter((section) => basis === "all" || section.basis === basis), [rows, activeModel, basis]);
  const ordered = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const modelRows = useMemo(() => rows.filter((row) => row.gpuModel === activeModel), [rows, activeModel]);
  const refresh = useCallback(() => { reloadBoard(); setRefreshVersion(refreshVersion + 1); }, [reloadBoard, refreshVersion, setRefreshVersion]);
  const list = useSeriesList({ focused, items: ordered, getId: (row) => row.id, matchesQuery: gpuMatches,
    selectedId, onSelect, reload: refresh, range: { value: basis, options: BASES, onChange: setBasis } });
  const visibleIds = useMemo(() => new Set(list.visible.map((row) => row.id)), [list.visible]);
  const listRows = useMemo(() => buildSectionedRows(sections.map((section) => ({ label: section.label, items: section.rows.filter((row) => visibleIds.has(row.id)) })),
    (row) => row.id), [sections, visibleIds]);
  const renderCell = (item: ListRow, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(item)) return EMPTY_TABLE_CELL;
    const row = item.item;
    const headline = gpuHeadline(row);
    if (column.id === "price") return { text: gpuPrice(row.pricePerGpuHr), value: row.pricePerGpuHr, color: headline ? colors.textBright : colors.text };
    const name = gpuShortSource(row);
    return { text: `${name} ${gpuVariant(row).join(" ")}`, content: <Box flexDirection="row" height={1} overflow="hidden">
      <Text fg={state.selected ? colors.selectedText : headline ? colors.textBright : colors.text} attributes={headline ? TextAttributes.BOLD : 0}>{name}</Text>
      <Text fg={state.selected ? colors.selectedText : colors.textDim}>{`  ${gpuVariant(row).join(" ")}`}</Text>
    </Box> };
  };
  return <SeriesListDetail list={list} width={width} height={height} focused={focused} listWidth={52}
    searchPlaceholder="Provider or variant" columns={listColumns} rows={listRows} getRowId={listRowId}
    filters={[{ id: "gpu", label: "GPU", value: activeModel, options: models.map((value) => ({ value, label: value })), onChange: setModel }]}
    isNavigable={isSectionedItemRow} renderSectionHeader={renderSectionedRowHeader}
    renderCell={renderCell} emptyStateTitle="No series match."
    renderDetail={(size) => list.selected ? <HistoryDetail key={list.selected.id} row={list.selected} peers={modelRows} refreshVersion={refreshVersion} {...size} />
      : <PaneStatusBody empty emptyTitle={`No ${gpuBasisLabel(basis === "all" ? "list" : basis as GpuBasis)} series yet.`} />} />;
}

