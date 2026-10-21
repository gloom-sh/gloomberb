import { useCallback, useMemo } from "react";
import type { CryptoEtfFlowAsset, CryptoEtfFlowDay } from "../../../api-client/crypto-etf-flows";
import { isAccessDenied } from "../../../api-client/errors";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  useChartTableSelection,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  type DataTableCell,
  type StatItem,
} from "../../../components";
import { formatCompactAxis } from "../../../components/chart-table";
import { useChartViewReset } from "../../../components/chart/core/view-reset";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { cachedCryptoEtfFlows, loadCryptoEtfFlows } from "./client";
import {
  CRYPTO_ETF_FLOW_ASSETS,
  CRYPTO_ETF_FLOW_RANGES,
  CRYPTO_ETF_FLOWS_PANE_ID,
  cryptoEtfFlowAsset,
  cryptoEtfFlowAssetLabel,
  cryptoEtfFlowColumns,
  cryptoEtfFlowRange,
  cryptoEtfFlowSummary,
  cumulativeFlows,
  daysInRange,
  flowColor,
  formatFlow,
  formatFlowAmount,
  fundTickerOfColumn,
  pendingText,
  type CryptoEtfFlowColumn,
  type CryptoEtfFlowRange,
} from "./model";

const EMPTY_DAYS: CryptoEtfFlowDay[] = [];
const rowId = (day: CryptoEtfFlowDay) => day.date;
const rowDate = (day: CryptoEtfFlowDay) => new Date(`${day.date}T00:00:00Z`);
/** Ticks in one compact unit for the axis (`$40B`, `-$1.5B`), with the decimals the plotted range needs. */
function formatFlowAxis(value: number, domain: Parameters<typeof formatCompactAxis>[1]): string {
  const text = formatCompactAxis(value, domain);
  return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
}
/** The legend's running total, in dollars: no sign for an inflow, as a level reads. */
const formatRunningTotal = (dollars: number) => formatFlowAmount(dollars / 1_000_000).replace(/^\+/, "");

export function CryptoEtfFlowsPane({ focused, width, height }: PaneProps) {
  const [assetSetting, setAssetSetting] = usePaneSettingValue<string>("asset", "btc");
  const asset = cryptoEtfFlowAsset(assetSetting);
  const [storedRange, setStoredRange] = usePluginPaneState<string>("range", "1Y");
  const range = cryptoEtfFlowRange(storedRange);
  const [selectedByAsset, setSelectedByAsset] = usePluginPaneState<Partial<Record<CryptoEtfFlowAsset, string>>>("selected", {});
  const resetChartView = useChartViewReset();

  const loader = useCallback((force: boolean) => loadCryptoEtfFlows(asset, force), [asset]);
  const resource = useAsyncResource(loader, { initialData: () => cachedCryptoEtfFlows(asset), clearOnError: isAccessDenied });
  // A copy of the other asset's flows is never drawn under this one's name.
  const data = resource.data?.payload.asset === asset ? resource.data.payload : null;
  const days = useMemo(() => data ? daysInRange(data.days, range) : EMPTY_DAYS, [data, range]);
  const columns = useMemo(() => cryptoEtfFlowColumns(data), [data]);
  const summary = useMemo(() => data ? cryptoEtfFlowSummary(data) : null, [data]);
  const selectedId = selectedByAsset[asset] && days.some((day) => day.date === selectedByAsset[asset]) ? selectedByAsset[asset]! : days[0]?.date ?? null;
  const selectDay = useCallback((id: string | null) => {
    setSelectedByAsset((current) => ({ ...current, [asset]: id ?? undefined }));
  }, [asset, setSelectedByAsset]);

  const label = cryptoEtfFlowAssetLabel(asset);
  // The running total since the first fund launched, drawn over the range the table lists.
  const series = useMemo(() => {
    if (!data) return [];
    const first = days.at(-1)?.date ?? "";
    const points = cumulativeFlows(data).filter((point) => point.date >= first)
      .map((point) => scalarPoint(new Date(`${point.date}T00:00:00Z`), point.value * 1_000_000));
    return [staticSeries(points, { id: `etf-flows:${asset}`, label: `${label} ETF net flows since launch`, color: colors.positive, calendarSpaced: true })];
  }, [asset, data, days, label]);
  const link = useChartTableSelection({ rows: days, getId: rowId, getDate: rowDate, selectedId, onSelect: selectDay, focused });

  const latest = summary?.latest ?? null;
  const pending = pendingText(latest);
  const figures: StatItem[] = summary ? [
    { id: "latest", label: "Latest day", value: formatFlowAmount(latest?.total), color: flowColor(latest?.total, colors),
      detail: [latest?.date, pending].filter(Boolean).join(" · ") || undefined },
    { id: "week", label: "5 days", value: formatFlowAmount(summary.week), color: flowColor(summary.week, colors) },
    { id: "month", label: "20 days", value: formatFlowAmount(summary.month), color: flowColor(summary.month, colors) },
    { id: "launch", label: "Since launch", value: formatFlowAmount(summary.sinceLaunch), color: flowColor(summary.sinceLaunch, colors),
      detail: summary.firstDate ? `since ${summary.firstDate}` : undefined },
  ] : [];

  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const footerInfo = useMemo(() => data ? [
    { id: "as-of", parts: [{ text: `as of ${data.asOf}`, tone: "muted" as const }] },
    ...(updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : []),
  ] : [], [data, updatedAgo]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const refresh = useCallback(() => void resource.reload(), [resource.reload]);
  usePaneRefreshKey(refresh, { focused });
  usePaneStatusLinkFooter({
    registrationId: CRYPTO_ETF_FLOWS_PANE_ID, focused, loading: resource.loading, error: data ? null : resource.error,
    url: data?.source.url ?? null, source: data?.source.publisher ?? null, label: "publisher", showOpenHint: true,
    info: footerInfo, stale: !!data && (data.stale || !!resource.data?.stale),
  });
  usePaneNoticeFooter({
    registrationId: `${CRYPTO_ETF_FLOWS_PANE_ID}:notices`, focused,
    notices: [
      ...(data?.stale ? [`The flows were last read ${data.fetchedAt.slice(0, 10)}; newer days may be missing.`] : []),
      ...(data && resource.data?.refreshError ? [resource.data.refreshError] : []),
    ],
  });

  const selectAsset = useCallback((value: string) => setAssetSetting(cryptoEtfFlowAsset(value).toLowerCase()), [setAssetSetting]);
  const selectRange = useCallback((value: CryptoEtfFlowRange) => setStoredRange(value), [setStoredRange]);
  // The number keys pick the range, as the bar's hints say; picking the one showing sends the chart back to it.
  const handleKeyDown = useCallback((event: Parameters<typeof handleRefreshKey>[0]) => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (!isPlainKeyboardEvent(event)) return false;
    const picked = CRYPTO_ETF_FLOW_RANGES.find((option) => option.hint === event.name);
    if (!picked) return false;
    event.preventDefault?.();
    if (picked.value === range) resetChartView();
    else selectRange(picked.value);
    return true;
  }, [range, refresh, resetChartView, selectRange]);

  const renderCell = useCallback((day: CryptoEtfFlowDay, column: CryptoEtfFlowColumn): DataTableCell => {
    if (column.id === "date") return { text: day.date, value: day.date, color: colors.text };
    if (column.id === "total") return { text: formatFlow(day.total), value: day.total, color: flowColor(day.total, colors) };
    const ticker = fundTickerOfColumn(column.id) ?? "";
    const value = day.flows[ticker] ?? null;
    // A fund that reported the day before and not yet today: its figure is to come, not none.
    if (value == null && day.pending.includes(ticker)) return { text: "pending", value: null, color: colors.textMuted };
    return { text: formatFlow(value), value, color: flowColor(value, colors) };
  }, []);

  const query = (
    <QueryBar
      width={width}
      filters={[
        { id: "asset", label: "Asset", inline: true, value: asset, options: CRYPTO_ETF_FLOW_ASSETS.map(({ value, label: name }) => ({ value, label: name })), onChange: selectAsset },
        { id: "range", label: "Range", inline: true, chartRange: true, value: range, options: CRYPTO_ETF_FLOW_RANGES, onChange: (value: string) => selectRange(cryptoEtfFlowRange(value)) },
      ]}
      meta="US$ millions"
    />
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} subject={`${label.toLowerCase()} ETF flows`}
        empty={!resource.loading && !resource.error && !!data && !data.days.length} emptyTitle={`No ${label.toLowerCase()} ETF flows listed yet.`}>
        {data ? (
          <DataTableView<CryptoEtfFlowDay, CryptoEtfFlowColumn>
            focused={focused}
            rootWidth={width}
            rootHeight={height}
            rootBefore={(
              <ChartTableHeader
                width={width}
                height={height}
                tableRows={days.length}
                tableColumns={columns}
                query={query}
                figures={figures}
                chart={{ series, formatValue: formatRunningTotal, formatAxisValue: formatFlowAxis, remoteKind: "crypto-etf-flows", ...link }}
              />
            )}
            selection={{ kind: "id", selectedId, getId: rowId, onChange: selectDay }}
            onRootKeyDown={handleKeyDown}
            columns={columns}
            items={days}
            freezeFirstColumn
            sortColumnId={null}
            sortDirection="desc"
            getItemKey={rowId}
            renderCell={renderCell}
            selectedTextOverridesCellColor
            resetScrollKey={`${asset}:${range}`}
            emptyStateTitle="No trading days in this range."
          />
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
