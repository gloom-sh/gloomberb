import { useCallback, useMemo } from "react";
import { listingIdentity } from "../shared/ticker-request";
import { Box, ScrollBox, useUiCapabilities } from "../../../ui";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useShortcut, useUpdatedAgo } from "../../../public/react";
import { CompositeChart, DataTableStackView, EmptyState, KeyValueRow, PaneStatusBody, usePaneNoticeFooter, usePaneStatusLinkFooter, type DataTableCell, StatGrid } from "../../../components";
import { colors } from "../../../theme/colors";
import type { ShortVolumeObservation } from "../../../api-client/short-volume";
import { ApiRequestError } from "../../../api-client/errors";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedShortVolume, loadShortVolume } from "./client";
import { exactQuantity, sortedVolumeHistory, VOLUME_COLUMNS, volumeChange, volumeHistoryPoints, volumePercent, volumePointStatus, volumeQuantity, type VolumeColumn, type VolumeSort } from "./model";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

const PANELS = [{ id: "main" }];
const DETAIL_LABEL_WIDTH = 26;
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
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
    initialData: () => symbol ? cachedShortVolume(symbol, scope) : null, clearOnError: clearDenied,
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
  const series = useMemo(() => [staticSeries(data ? volumeHistoryPoints(data) : [], {
    id: "daily-short-ratio", label: "Off-exchange short ratio (%)", color: colors.warning, calendarSpaced: true,
  })], [data]);
  const chartHeight = height >= 16 ? Math.max(5, Math.min(12, Math.floor(height * .38))) : 0;
  const latest = data?.latest;
  const stats = latest?.percentile;
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => { if (focused && isPlainKey(event, "r")) { event.preventDefault(); void resource.reload(); } });
  usePaneNoticeFooter({ registrationId: "short-volume:notices", focused,
    notices: [...(data?.warnings ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: "short-volume", focused, loading: resource.loading, error: resource.error,
    url: selected?.sourceUrl ?? data?.source.url ?? null, showOpenHint: true,
    info: data ? [
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : []),
      ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(data.status !== "available" ? [{ id: "partial", parts: [{ text: data.status, tone: "warning" as const }] }] : []),
    ] : [],
  });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view daily short volume" needsVerification={session.needsVerification} />;
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
        rootBefore={<Box flexDirection="column" flexShrink={0}>
          {/* "Short ratio" reads as days to cover, so the band names the table's SHORT % column. */}
          <StatGrid width={width} items={[
            { id: "ratio", label: scope === "otc" ? "OTC short %" : "Short %", value: volumePercent(latest?.ratioPercent ?? null),
              detail: `${stats?.value == null ? "--" : stats.value.toFixed(0)} pctl ${stats?.completeWindow ? "1Y" : "sample"}` },
            { id: "change", label: "Daily change", value: volumeChange(latest?.changePp ?? null), detail: latest?.previousDate ? `since ${latest.previousDate}` : undefined },
            { id: "range", label: stats?.completeWindow ? "1Y range" : "Sample range", value: `${volumePercent(stats?.min ?? null)} to ${volumePercent(stats?.max ?? null)}`,
              detail: stats ? `${stats.historyStart ?? "--"} to ${stats.historyEnd ?? "--"}` : undefined },
          ]} />
          {chartHeight && data.history.some((point) => point.ratioPercent !== null) ? <Box paddingX={1} flexShrink={0}>
            <CompositeChart series={series} panels={PANELS} width={Math.max(1, width - 2)} height={chartHeight} showLegend={false} showTimeAxis navigable={false}
              formatAxisValue={(value) => `${value.toFixed(0)}%`} remoteKind="short-volume-history" />
          </Box> : null}
        </Box>}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
