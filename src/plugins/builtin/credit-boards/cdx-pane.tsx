import { useMemo } from "react";
import {
  ChartTableHeader,
  CompositeChart,
  MarketBoardStack,
  PaneStatusBody,
  type ChartTableChart,
  type PaneFooterSegment,
  type StatItem,
} from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { signedMoveColor, StatChartDetail } from "../../../components/market-board";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { colors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { formatPercentileRank } from "../../../utils/format";
import { usePluginPaneState } from "../../runtime";
import { formatAsOf } from "../cds/model";
import { getCachedCdxBoard, loadCdxBoard } from "./client";
import {
  axisFormatter,
  cdxRows,
  formatContract,
  formatLevel,
  formatMove,
  type CdxRow,
} from "./model";

const PANELS = [{ id: "main" }];
const EMPTY_ROWS: CdxRow[] = [];

/** The index's 5Y line, named as the board names it. */
function historySeries(row: CdxRow) {
  return [staticSeries(row.index.points.map((point) => ({
    date: new Date(`${point.date}T00:00:00Z`), observedAt: new Date(`${point.date}T00:00:00Z`), value: point.level,
  })), { id: row.id, label: `${row.label} 5Y`, color: colors.positive, calendarSpaced: true })];
}

function historyChart(row: CdxRow): ChartTableChart {
  const quote = row.index.quote;
  return {
    series: row.index.points.length >= 3 ? historySeries(row) : [],
    formatValue: (value: number) => formatLevel(quote, value),
    formatAxisValue: axisFormatter(quote),
    remoteKind: "cdx-history",
    // An index without a history keeps the band, so the board does not jump under the cursor.
    empty: `No history for ${row.label}`,
  };
}

function HistoryChart({ row, width, height, focused }: { row: CdxRow; width: number; height: number; focused: boolean }) {
  const series = useMemo(() => historySeries(row), [row]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={axisFormatter(row.index.quote)} remoteKind="cdx-history" />;
}

function IndexDetail({ row, width, height, focused }: { row: CdxRow; width: number; height: number; focused: boolean }) {
  const { index, year } = row;
  const items: StatItem[] = [
    { id: "level", label: index.quote === "spread" ? "5Y spread" : "5Y price", value: formatLevel(index.quote, index.level),
      detail: `${formatPercentileRank(year.percentile, "1Y")} · ${index.date ?? "--"}` },
    { id: "1d", label: "1D", value: formatMove(index.quote, index.change1D) },
    { id: "1w", label: "1W", value: formatMove(index.quote, index.change1W) },
    { id: "range", label: "1Y range", value: `${formatLevel(index.quote, year.low)} to ${formatLevel(index.quote, year.high)}` },
    { id: "contract", label: "Contract", value: formatContract(index.maturity), detail: `${index.couponBp}bp coupon` },
    { id: "prints", label: "Prints", value: index.prints == null ? "--" : String(index.prints) },
  ];
  return (
    <StatChartDetail items={items} width={width} height={height} empty={index.points.length < 3}
      emptySubject="index history" emptyTitle="No history available."
      renderChart={(chartHeight) => <HistoryChart row={row} width={width} height={chartHeight} focused={focused} />} />
  );
}

export function CdxPane({ paneId, focused, width, height }: PaneProps) {
  const theme = useThemeColors();
  const resource = useAsyncResource(loadCdxBoard, { initialData: getCachedCdxBoard });
  const { loading, load: refresh, reload } = resource;
  const payload = resource.data?.payload ?? null;
  const rows = useMemo(() => payload ? cdxRows(payload.indexes, payload.asOf) : EMPTY_ROWS, [payload]);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  useAutoRefresh(resource.updatedAt, refresh);
  usePaneRefreshKey(reload, { focused, enabled: !loading });

  const asOf = formatAsOf(payload?.asOf ?? null);
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(asOf ? [{ id: "as-of", parts: [{ text: `as of ${asOf}`, tone: "muted" as const }] }] : []),
    ...(payload ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
    ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
  ], [asOf, payload, resource.data?.stale]);
  usePaneStatusFooter({
    registrationId: paneId,
    loading,
    error: resource.error ?? resource.data?.refreshError ?? null,
    info,
  });

  // The 1W move and the print count ride beside the board's own 1D column.
  const extraColumns = useMemo(() => [
    {
      column: { id: "week", label: "1W", width: 10, align: "right" as const },
      sortValue: (row: CdxRow) => row.index.change1W,
      renderCell: (row: CdxRow) => ({
        text: formatMove(row.index.quote, row.index.change1W),
        color: signedMoveColor(row.index.change1W, row.adverseMove, theme),
      }),
    },
    {
      column: { id: "prints", label: "PRINTS", width: 7, align: "right" as const },
      sortValue: (row: CdxRow) => row.index.prints,
      renderCell: (row: CdxRow) => ({
        text: row.index.prints == null ? "--" : String(row.index.prints),
        color: theme.textMuted,
      }),
    },
  ], [theme]);

  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={resource.error} empty={!loading && !resource.error}
        loadingLabel="Loading index CDS..." subject="Index CDS" align="center" width={width} height={height} />
    );
  }

  // The selected index's history sits above the board; the legend names it.
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  return (
    <MarketBoardStack rows={rows} width={width} height={height} focused={focused}
      rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={rows.length}
        tableColumns={columns} chart={selected ? historyChart(selected) : null} />}
      selectedId={selectedId} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
      labelHeader="INDEX" labelWidth={16} valueLabel="5Y" valueWidth={9} signedChange extraColumns={extraColumns}
      renderDetail={(row) => <IndexDetail row={row} width={width} height={Math.max(5, height - 2)} focused={focused} />} />
  );
}
