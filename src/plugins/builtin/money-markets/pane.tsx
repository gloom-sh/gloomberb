import { useCallback, useMemo } from "react";
import { Box } from "../../../ui";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useShortcut, useUpdatedAgo } from "../../../public/react";
import { CompositeChart, CurveSurface, EmptyState, MarketBoardStack, PaneStatusBody, StatGrid, statGridRows, Tabs, usePaneHeaderTabs, usePaneNoticeFooter, usePaneStatusLinkFooter, type MarketBoardRow, type StatItem } from "../../../components";
import { colors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { ApiRequestError } from "../../../api-client/errors";
import type { MoneyMarketRow } from "../../../api-client/money-markets";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
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

function ObservationChart({ row, width, height, focused = false }: { row: MoneyMarketRow; width: number; height: number; focused?: boolean }) {
  const series = useMemo(() => [staticSeries(moneyMarketHistory(row).map((point) => ({ date: new Date(point.date), observedAt: new Date(point.date), value: point.value })),
    { id: row.id, label: row.label, color: colors.positive, calendarSpaced: true })], [row]);
  if (row.history.every((point) => point.value == null)) return <Box width={width} height={height}><EmptyState title="No history available." /></Box>;
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={(value) => moneyMarketValue(value, row.unit)} remoteKind="money-market-history" />;
}

function ObservationDetail({ row, width, height, focused = false }: { row: MoneyMarketRow; width: number; height: number; focused?: boolean }) {
  const p = row.percentile;
  // The chart below shows the 1Y window, so the range carries no sample count or window dates.
  const items: StatItem[] = [
    { id: "level", label: row.unit === "percent" ? "Rate" : "USD billions", value: moneyMarketValue(row.value, row.unit),
      detail: `${p.value == null ? "--" : p.value.toFixed(0)} pctl 1Y · ${row.asOf ?? "--"}` },
    { id: "change", label: "Change", value: moneyMarketChange(row.change, row.changeUnit), detail: `since ${row.previousAsOf ?? "--"}` },
    { id: "range", label: "1Y range", value: `${moneyMarketValue(p.min, row.unit)} to ${moneyMarketValue(p.max, row.unit)}` },
    { id: "series", label: "FRED", value: row.sourceSeriesIds.join(", "), detail: row.frequency },
  ];
  const statRows = statGridRows(items, width);
  return <Box flexDirection="column" width={width} height={height}>
    <StatGrid items={items} width={width} />
    <PaneStatusBody empty={row.history.every((point) => point.value == null)} subject="history" emptyTitle="No history available.">
      <ObservationChart row={row} width={width} height={Math.max(3, height - statRows)} focused={focused} />
    </PaneStatusBody>
  </Box>;
}

export function MoneyMarketsPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadMoneyMarkets(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: getCachedMoneyMarkets, clearOnError: clearDenied });
  const [tab, setTab] = usePaneSettingValue("tab", "rates");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const data = resource.data?.payload;
  const rows = useMemo(() => data ? moneyMarketRows(data, tab).map(boardRow) : [], [data, tab]);
  const curves = useMemo(() => data ? moneyMarketCurves(data, { current: colors.positive, ghosts: { "1W": colors.textMuted, "1M": colors.warning, "1Y": colors.textDim } }) : [], [data, colors]);
  const openRow = rows.find((row) => row.id === openId);
  const selected = openRow ?? rows.find((row) => row.id === selectedId);
  const slope = data?.billsCurve.slope;
  // The curve's slope is the Bills tab's summary figure; the legend dates the latest curve.
  const billsItems: StatItem[] = slope ? [{ id: "slope", label: "1Y-4W",
    value: slope.valueBps == null ? "--" : `${slope.valueBps > 0 ? "+" : ""}${slope.valueBps.toFixed(1)}bp`,
    detail: [`${slope.percentile.value == null ? "--" : slope.percentile.value.toFixed(0)} pctl 1Y`,
      slope.asOf && slope.asOf !== data?.billsCurve.asOf ? slope.asOf : null].filter(Boolean).join(" · ") }] : [];
  const rateChartRow = tab === "rates" ? (selected ?? rows[0])?.observation : undefined;
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused });
  const tabRows = tabsInHeader ? 0 : 1;
  const boardHeight = Math.max(3, Math.min(rows.length + 2, Math.floor((height - tabRows) * 0.45)));
  const curveHeight = Math.max(8, height - tabRows - boardHeight);
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => { if (focused && isPlainKey(event, "r")) { event.preventDefault(); void resource.reload(); } });
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
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={focused} dense />}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!resource.loading && !resource.error && !data} subject="money markets">
      {data ? <MarketBoardStack rows={rows} width={width} height={Math.max(3, height - tabRows)} focused={focused}
        selectedId={selectedId} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
        changeLabel="Δ OBS" renderDetail={(row) => <ObservationDetail row={row.observation} width={width} height={Math.max(5, height - tabRows - 2)} focused={focused} />}
        rootBefore={tab === "bills" ? <>
          <StatGrid items={billsItems} width={width} />
          <CurveSurface series={curves} width={width} height={Math.max(6, curveHeight - statGridRows(billsItems, width))} display="chart"
            selectedPointId={data.billsCurve.points.find((point) => point.seriesId === selected?.observation.seriesId)?.tenor ?? null}
            valueLabel="Discount yield (%)" formatValue={(value) => `${value.toFixed(2)}%`} formatX={(value) => `${(value * 12).toFixed(1)} months`} />
        </>
          : tab === "liquidity" ? <ObservationChart row={data.netLiquidity} width={width} height={curveHeight} focused={focused && !openRow} />
          // Rates charts the selected funding rate's year, like Liquidity.
          : rateChartRow ? <ObservationChart row={rateChartRow} width={width} height={curveHeight} focused={focused && !openRow} /> : undefined} /> : null}
    </PaneStatusBody>
  </Box>;
}
