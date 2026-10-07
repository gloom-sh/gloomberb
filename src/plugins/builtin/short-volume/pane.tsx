import { useCallback, useMemo } from "react";
import { listingIdentity } from "../shared/ticker-request";
import { Box, ScrollBox, useUiCapabilities } from "../../../ui";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { ChartTableHeader, DataTableStackView, EmptyState, formatPercentAxis, KeyValueRow, PaneStatusBody, useChartTableSelection, usePaneNoticeFooter, usePaneStatusLinkFooter, type DataTableCell, type StatItem } from "../../../components";
import { colors } from "../../../theme/colors";
import type { ShortVolumeObservation } from "../../../api-client/short-volume";
import { isAccessDenied } from "../../../api-client/errors";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { formatPercentileRank } from "../../../utils/format";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedShortVolume, loadShortVolume } from "./client";
import { exactQuantity, sortedVolumeHistory, VOLUME_COLUMNS, volumeChange, volumeHistoryPoints, volumePercent, volumePointStatus, volumeQuantity, type VolumeColumn, type VolumeSort } from "./model";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

const DETAIL_LABEL_WIDTH = 26;
const rowDate = (row: ShortVolumeObservation) => row.ratioPercent == null ? null : new Date(row.date);
function renderCell(row: ShortVolumeObservation, column: VolumeColumn, _index: number, state: { selected: boolean }): DataTableCell {
  const text = column.id === "date" ? row.date : column.id === "ratioPercent" ? volumePercent(row.ratioPercent)
    : column.id === "status" ? volumePointStatus(row) : volumeQuantity(row[column.id]);
  return { text, color: state.selected ? colors.selectedText : column.id === "ratioPercent" ? colors.warning
    : row.unavailableReason ? colors.textMuted : colors.text };
}
function VolumeDetail({ row, width, height }: { row: ShortVolumeObservation; width: number; height: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  // The stack title is the date, so the rows start with the figures.
  return <ScrollBox width={width} height={nativePaneChrome ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Off-exchange short ratio" value={volumePercent(row.ratioPercent)} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Short shares" value={exactQuantity(row.shortVolume)} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Exempt shares" value={exactQuantity(row.shortExemptVolume)} detail="included in short shares" />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Total shares" value={exactQuantity(row.totalVolume)} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Reporting facilities" value={row.markets.join(", ") || "--"} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Observation" value={volumePointStatus(row)} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Retrieved" value={row.fetchedAt?.replace("T", " ").replace(/\.\d+Z$/, " UTC") ?? "--"} />
  </ScrollBox>;
}
export function ShortVolumePane({ width, height, focused }: Pick<PaneProps, "width" | "height" | "focused">) {
  const { ticker } = usePaneTickerIdentity();
  const [sourceSymbol] = usePaneSettingValue("finraSymbol", "");
  const [scopeValue] = usePaneSettingValue("shortVolumeScope", "nms");
  const scope = scopeValue === "otc" ? "otc" : "nms";
  const symbol = sourceSymbol.trim() || listingIdentity(ticker?.metadata.ticker)?.symbol || null;
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadShortVolume(symbol!, scope, force), [symbol, scope, session.requestKey]);
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => symbol ? cachedShortVolume(symbol, scope) : null, clearOnError: isAccessDenied,
  });
  const data = resource.data?.payload;
  const identity = `${scope}:${symbol}`;
  const [sort, setSort] = usePluginPaneState<VolumeSort>("short-volume:sort", { column: "date", direction: "desc" });
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("short-volume:selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("short-volume:open", null);
  const rowKey = (row: ShortVolumeObservation) => `${identity}:${row.date}`;
  const rows = useMemo(() => data ? sortedVolumeHistory(data, sort) : [], [data, sort]);
  const selectedIndex = Math.max(0, rows.findIndex((row) => rowKey(row) === selectedId));
  const openRow = rows.find((row) => rowKey(row) === openId);
  const selected = openRow ?? rows[selectedIndex];
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  // The legend names the series, so it reads the same as the SHORT % column.
  const series = useMemo(() => [staticSeries(data ? volumeHistoryPoints(data) : [], {
    id: "daily-short-ratio", label: scope === "otc" ? "OTC short %" : "Short %", color: colors.warning, calendarSpaced: true,
  })], [data, scope]);
  const latest = data?.latest;
  const stats = latest?.percentile;
  const link = useChartTableSelection({
    rows, getId: rowKey, getDate: rowDate, selectedId: rows[selectedIndex] ? rowKey(rows[selectedIndex]!) : null,
    onSelect: setSelectedId, focused: focused && !openRow,
  });
  // "Short ratio" reads as days to cover, so the figures name the table's SHORT % column.
  const figures: StatItem[] = [
    { id: "ratio", label: scope === "otc" ? "OTC short %" : "Short %", value: volumePercent(latest?.ratioPercent ?? null),
      detail: formatPercentileRank(stats?.value, stats?.completeWindow ? "1Y" : "sample") },
    { id: "change", label: "Daily change", value: volumeChange(latest?.changePp ?? null), detail: latest?.previousDate ? `since ${latest.previousDate}` : undefined },
    { id: "range", label: stats?.completeWindow ? "1Y range" : "Sample range", value: `${volumePercent(stats?.min ?? null)} to ${volumePercent(stats?.max ?? null)}`,
      detail: stats ? `${stats.historyStart ?? "--"} to ${stats.historyEnd ?? "--"}` : undefined },
  ];
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneNoticeFooter({ registrationId: "short-volume:notices", focused,
    notices: [...(data?.warnings ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: "short-volume", focused, loading: resource.loading, error: resource.error,
    url: selected?.sourceUrl ?? data?.source.url ?? null, showOpenHint: true,
    info: data && updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : [],
    stale: !!data && resource.data?.stale,
  });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="short-volume-signin" action="view daily short volume" needsVerification={session.needsVerification} />;
  if (!symbol) return <EmptyState title="No ticker selected." message="Select a ticker to view daily short volume." />;
  return <Box flexDirection="column" width={width} height={height}>
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} subject="daily short volume"
      empty={!resource.loading && !resource.error && !!data && !data.history.length} emptyTitle="Daily short volume is awaiting source history.">
      {data ? <DataTableStackView<ShortVolumeObservation, VolumeColumn>
        focused={focused} rootWidth={width} rootHeight={height} emptyStateTitle="No reported daily volume." columns={VOLUME_COLUMNS} items={rows} freezeFirstColumn
        getItemKey={rowKey} renderCell={renderCell} resetScrollKey={identity}
        selection={{ kind: "index", selectedIndex: rows.length ? selectedIndex : -1, onChange: (index) => setSelectedId(rows[index] ? rowKey(rows[index]!) : null) }}
        onActivate={(row) => setOpenId(rowKey(row))} detailOpen={!!openRow} onBack={() => setOpenId(null)}
        detailTitle={openRow?.date} detailContent={openRow ? <VolumeDetail row={openRow} width={width} height={Math.max(3, height - 2)} /> : null}
        sortColumnId={sort.column} sortDirection={sort.direction}
        onHeaderClick={(column) => setSort((current) => ({ column: column as VolumeSort["column"], direction: current.column === column && current.direction === "desc" ? "asc" : "desc" }))}
        rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={VOLUME_COLUMNS} figures={figures} chart={{
          series, formatValue: volumePercent, formatAxisValue: formatPercentAxis, remoteKind: "short-volume-history", ...link,
        }} />}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
