import { useCallback, useMemo } from "react";
import { Box } from "../../../ui";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useShortcut, useUpdatedAgo } from "../../../public/react";
import { ChartTableHeader, CompositeChart, CurveSurface, curveGhostColors, EmptyState, formatPercentAxis, MarketBoardStack, PaneStatusBody, StatGrid, statGridRows, Tabs, useChartTableSelection, usePaneHeaderTabs, usePaneNoticeFooter, usePaneStatusLinkFooter, type ChartTableChart, type MarketBoardRow, type StatItem } from "../../../components";
import { curveStrip, curveSurfaceMinRows } from "../../../components/chart/curve";
import { colors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { isAccessDenied } from "../../../api-client/errors";
import type { MoneyMarketRow } from "../../../api-client/money-markets";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedMoneyMarkets, loadMoneyMarkets } from "./client";
import { moneyMarketAxis, moneyMarketChange, moneyMarketCurves, moneyMarketHistory, moneyMarketNotices, moneyMarketRateChange, moneyMarketRows, moneyMarketValue } from "./model";

const TABS = [{ value: "rates", label: "Rates" }, { value: "bills", label: "Bills" }, { value: "liquidity", label: "Liquidity" }];
const PANELS = [{ id: "main" }];
const BILLS_CAPTION = "Discount yield % by bill tenor";
const formatRate = (value: number) => moneyMarketValue(value, "percent");
interface BoardRow extends MarketBoardRow { observation: MoneyMarketRow }
const boardKey = (row: BoardRow) => row.id;
function boardRow(row: MoneyMarketRow): BoardRow {
  return { id: row.id, label: row.label, value: row.value, valueText: moneyMarketValue(row.value, row.unit),
    change: row.change, changeText: moneyMarketChange(row.change, row.changeUnit), percentile: row.percentile.value,
    asOf: row.asOf, status: row.status, observation: row,
    history: moneyMarketHistory(row).flatMap((point) => point.value == null ? [] : [{ date: new Date(point.date), close: point.value }]),
  };
}

/** The year the board's rank and range come from, named like its row. */
function observationSeries(row: MoneyMarketRow) {
  return [staticSeries(moneyMarketHistory(row).map((point) => ({ date: new Date(point.date), observedAt: new Date(point.date), value: point.value })),
    { id: row.id, label: row.label, color: colors.positive, calendarSpaced: true })];
}

function ObservationChart({ row, width, height, focused = false }: { row: MoneyMarketRow; width: number; height: number; focused?: boolean }) {
  const series = useMemo(() => observationSeries(row), [row]);
  if (row.history.every((point) => point.value == null)) return <Box width={width} height={height}><EmptyState title="No history available." /></Box>;
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={moneyMarketAxis(row.unit)} remoteKind="money-market-history" />;
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
  const resource = useAsyncResource(loader, { initialData: getCachedMoneyMarkets, clearOnError: isAccessDenied });
  const [tab, setTab] = usePaneSettingValue("tab", "rates");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const data = resource.data?.payload;
  const rows = useMemo(() => data ? moneyMarketRows(data, tab).map(boardRow) : [], [data, tab]);
  const curves = useMemo(() => data ? moneyMarketCurves(data, { current: colors.positive, ghosts: curveGhostColors(colors) }) : [], [data, colors]);
  const openRow = rows.find((row) => row.id === openId);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? rows[0];
  const selected = openRow ?? selectedRow;
  const slope = data?.billsCurve.slope;
  // The curve's slope is the Bills tab's summary figure.
  const billsItems: StatItem[] = slope ? [{ id: "slope", label: "1Y-4W",
    value: slope.valueBps == null ? "--" : `${slope.valueBps > 0 ? "+" : ""}${slope.valueBps.toFixed(1)}bp`,
    detail: [`${slope.percentile.value == null ? "--" : slope.percentile.value.toFixed(0)} pctl 1Y`,
      slope.asOf && slope.asOf !== data?.billsCurve.asOf ? slope.asOf : null].filter(Boolean).join(" · ") }] : [];
  // A bill row and its tenor on the curve are one selection, matched by FRED series.
  const bills = useMemo(() => {
    const tenors = new Map<string, { tenor: string; years: number }>();
    for (const snapshot of data ? [data.billsCurve, ...data.billsCurve.comparisons] : []) {
      for (const point of snapshot.points) {
        const row = rows.find((entry) => entry.observation.seriesId === point.seriesId);
        if (row && !tenors.has(row.id)) tenors.set(row.id, { tenor: point.tenor, years: point.maturityYears });
      }
    }
    return tenors;
  }, [data, rows]);
  const billRowOf = (tenor: string) => [...bills].find(([, bill]) => bill.tenor === tenor)?.[0];
  const billsTab = tab === "bills";
  // Left and Right step along the maturities, the way the curve reads.
  const billDate = useCallback((row: BoardRow) => {
    const years = bills.get(row.id)?.years;
    return years == null ? null : new Date(years * 365.25 * 86_400_000);
  }, [bills]);
  useChartTableSelection({ rows, getId: boardKey, getDate: billDate, selectedId: selectedRow?.id ?? null, onSelect: setSelectedId,
    focused: focused && !openRow, enabled: billsTab });
  const selectedTenor = selectedRow ? bills.get(selectedRow.id)?.tenor ?? null : null;
  const billsStrip = billsTab ? curveStrip(curves, formatRate, { caption: "Discount yield", selectedPointId: selectedTenor }) : null;
  // Rates and Liquidity chart the selected row's year; the legend names the row.
  const boardSeries = useMemo(() => selectedRow ? observationSeries(selectedRow.observation) : [], [selectedRow]);
  const chart: ChartTableChart | null = billsTab ? billsStrip ? {
    render: (size) => <CurveSurface series={curves} width={size.width} height={size.height} display="chart"
      caption={BILLS_CAPTION} xScale="log" formatValue={formatRate} formatChange={moneyMarketRateChange}
      formatAxisValue={formatPercentAxis} selectedPointId={selectedTenor}
      onSelectedPointChange={(tenor) => { const id = billRowOf(tenor); if (id) setSelectedId(id); }} />,
    minRows: curveSurfaceMinRows({ series: curves, width, caption: BILLS_CAPTION }),
    strip: billsStrip,
  } : null : selectedRow ? {
    series: boardSeries, formatValue: (value) => moneyMarketValue(value, selectedRow.observation.unit),
    formatAxisValue: moneyMarketAxis(selectedRow.observation.unit), remoteKind: "money-market-history",
    // A rate without a history keeps the band, so the board does not jump as the cursor passes it.
    empty: `No history for ${selectedRow.label}`,
  } : null;
  const figures = billsTab ? billsItems : [];
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused });
  const bodyHeight = Math.max(3, height - (tabsInHeader ? 0 : 1));
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => { if (focused && isPlainKey(event, "r")) { event.preventDefault(); void resource.reload(); } });
  usePaneNoticeFooter({ registrationId: "money-markets:notices", focused,
    notices: [...(data ? moneyMarketNotices(data) : []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: "money-markets", focused, loading: resource.loading, error: resource.error,
    url: selected?.observation.sourceUrl ?? null, showOpenHint: true,
    info: data ? [
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : []),
      ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ] : [],
  });
  return <Box width={width} height={height} flexDirection="column">
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={focused} dense />}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!resource.loading && !resource.error && !data} subject="money markets">
      {data ? <MarketBoardStack rows={rows} width={width} height={bodyHeight} focused={focused}
        selectedId={selectedRow?.id ?? null} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
        changeLabel="Δ OBS" renderDetail={(row) => <ObservationDetail row={row.observation} width={width} height={Math.max(5, bodyHeight - 2)} focused={focused} />}
        rootBefore={({ columns }) => <ChartTableHeader width={width} height={bodyHeight} figures={figures} chart={chart}
          tableRows={rows.length} tableColumns={columns} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
