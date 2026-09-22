import { useCallback, useMemo } from "react";
import { Box } from "gloomberb/ui";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useShortcut, useUpdatedAgo } from "gloomberb/react";
import { CompositeChart, CurveSurface, EmptyState, KeyValueRow, MarketBoardStack, PaneStatusBody, Tabs, usePaneNoticeFooter, usePaneStatusLinkFooter, type MarketBoardRow } from "gloomberb/components";
import { colors } from "gloomberb/theme";
import { ApiRequestError } from "../../../api-client/errors";
import type { MoneyMarketRow } from "../../../api-client/money-markets";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedMoneyMarkets, loadMoneyMarkets } from "./client";
import { moneyMarketChange, moneyMarketCurves, moneyMarketHistory, moneyMarketNotices, moneyMarketRows, moneyMarketValue } from "./model";

const TABS = [{ value: "rates", label: "Rates" }, { value: "bills", label: "Bills" }, { value: "liquidity", label: "Liquidity" }];
const PANELS = [{ id: "main" }];
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
interface BoardRow extends MarketBoardRow { observation: MoneyMarketRow }
function boardRow(row: MoneyMarketRow): BoardRow {
  return { id: row.id, label: row.label, value: row.value, valueText: moneyMarketValue(row.value, row.unit),
    change: row.change, changeText: moneyMarketChange(row.change, row.changeUnit), percentile: row.percentile.value,
    asOf: row.asOf, status: row.status, observation: row,
    history: moneyMarketHistory(row).flatMap((point) => point.value == null ? [] : [{ date: new Date(point.date), close: point.value }]),
  };
}

function ObservationChart({ row, width, height }: { row: MoneyMarketRow; width: number; height: number }) {
  const series = useMemo(() => [staticSeries(moneyMarketHistory(row).map((point) => ({ date: new Date(point.date), observedAt: new Date(point.date), value: point.value })),
    { id: row.id, label: row.label, color: colors.positive, calendarSpaced: true })], [row]);
  if (row.history.every((point) => point.value == null)) return <Box width={width} height={height}><EmptyState title="No history available." /></Box>;
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={(value) => moneyMarketValue(value, row.unit)} remoteKind="money-market-history" />;
}

function ObservationDetail({ row, width, height }: { row: MoneyMarketRow; width: number; height: number }) {
  const p = row.percentile;
  return <Box flexDirection="column" width={width} height={height}>
    <Box paddingX={1} flexShrink={0} flexDirection="column">
      <KeyValueRow label={row.unit === "percent" ? "Rate" : "USD billions"} value={moneyMarketValue(row.value, row.unit)}
        detail={`${p.value == null ? "--" : p.value.toFixed(0)} pctl 1Y · ${row.asOf ?? "--"}`} />
      <KeyValueRow label="Change" value={moneyMarketChange(row.change, row.changeUnit)} detail={`since ${row.previousAsOf ?? "--"}`} />
      <KeyValueRow label="1Y range" value={`${moneyMarketValue(p.min, row.unit)} to ${moneyMarketValue(p.max, row.unit)}`}
        detail={`${p.sampleCount} observations · ${p.windowStart ?? "--"} to ${p.windowEnd ?? "--"}`} />
      <KeyValueRow label="FRED" value={row.sourceSeriesIds.join(", ")} detail={row.frequency} />
    </Box>
    <PaneStatusBody empty={row.history.every((point) => point.value == null)} subject="history" emptyTitle="No history available.">
      <ObservationChart row={row} width={width} height={Math.max(3, height - 4)} />
    </PaneStatusBody>
  </Box>;
}

export function MoneyMarketsPane({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadMoneyMarkets(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: getCachedMoneyMarkets, clearOnError: clearDenied });
  const [tab, setTab] = usePaneSettingValue("tab", "rates");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const data = resource.data?.payload;
  const rows = useMemo(() => data ? moneyMarketRows(data, tab).map(boardRow) : [], [data, tab]);
  const curves = useMemo(() => data ? moneyMarketCurves(data) : [], [data]);
  const selected = rows.find((row) => row.id === openId) ?? rows.find((row) => row.id === selectedId);
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const curveHeight = Math.max(8, Math.min(16, height - 8));
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => { if (focused && event.name === "r") { event.preventDefault(); void resource.reload(); } });
  usePaneNoticeFooter({ registrationId: "money-markets:notices", focused,
    notices: [...(data ? moneyMarketNotices(data) : []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: "money-markets", focused, loading: resource.loading, error: resource.error,
    url: selected?.observation.sourceUrl ?? null, showOpenHint: true,
    info: data ? [
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : []),
      ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(data.status !== "available" ? [{ id: "partial", parts: [{ text: data.status, tone: "warning" as const }] }] : []),
    ] : [],
  });
  return <Box width={width} height={height} flexDirection="column">
    <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={focused} dense />
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!resource.loading && !resource.error && !data} subject="money markets">
      {data ? <MarketBoardStack rows={rows} width={width} height={Math.max(3, height - 1)} focused={focused}
        selectedId={selectedId} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
        changeLabel="Δ OBS" renderDetail={(row) => <ObservationDetail row={row.observation} width={width} height={Math.max(5, height - 3)} />}
        rootBefore={tab === "bills" ? <CurveSurface series={curves} width={width} height={curveHeight} display="chart"
          selectedPointId={data.billsCurve.points.find((point) => point.seriesId === selected?.observation.seriesId)?.tenor ?? null}
          valueLabel="Discount yield (%)" formatValue={(value) => `${value.toFixed(2)}%`} formatX={(value) => `${(value * 12).toFixed(1)} months`}
          slope={{ label: "1Y-4W", value: data.billsCurve.slope.valueBps, percentile: data.billsCurve.slope.percentile.value,
            window: "1Y", asOf: data.billsCurve.slope.asOf, formatValue: (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)}bp` }} />
          : tab === "liquidity" ? <ObservationChart row={data.netLiquidity} width={width} height={curveHeight} /> : undefined} /> : null}
    </PaneStatusBody>
  </Box>;
}
