import { useMemo } from "react";
import {
  DELAYED_SEGMENT,
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
import { FIXED_INCOME_PANE_ID } from "../fixed-income/model";
import { useCommandValue } from "../shared/command-tab";
import { getCachedCdxBoard, loadCdxBoard } from "./client";
import {
  axisFormatter,
  cdxRows,
  findIndex,
  formatContract,
  formatLevel,
  formatMove,
  partialDayText,
  SETTLEMENT_TEXT,
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
  const { index, year, day } = row;
  // While today trades the moves run to the last complete day, which the 1D says.
  const through = day.partial && day.changeDate ? `to ${day.changeDate}` : undefined;
  const items: StatItem[] = [
    { id: "level", label: index.quote === "spread" ? "5Y spread" : "5Y price", value: formatLevel(index.quote, index.level),
      detail: [formatPercentileRank(year.percentile, "1Y"), index.date ?? "--", ...(index.kind === "settlement" ? [SETTLEMENT_TEXT] : [])].join(" · ") },
    ...(index.quote === "price" && index.spreadBp !== undefined ? [{ id: "spread", label: "Spread eq", value: formatLevel("spread", index.spreadBp ?? null),
      ...(index.recovery != null ? { detail: `${Math.round(index.recovery * 100)}% recovery` } : {}) }] : []),
    { id: "1d", label: "1D", value: formatMove(index.quote, day.change1D), ...(through ? { detail: through } : {}) },
    { id: "1w", label: "1W", value: formatMove(index.quote, day.change1W) },
    { id: "1m", label: "1M", value: formatMove(index.quote, day.change1M) },
    { id: "range", label: "1Y range", value: `${formatLevel(index.quote, year.low)} to ${formatLevel(index.quote, year.high)}` },
    { id: "contract", label: "Contract", value: formatContract(index.maturity), detail: `${index.couponBp}bp coupon` },
    { id: "prints", label: "Prints", value: index.prints == null ? "--" : String(index.prints),
      // The value is the count already: the detail says only that the day is still trading, and its last print.
      ...(day.partial ? { detail: partialDayText(null, day.lastPrintAt) } : {}) },
  ];
  return (
    <StatChartDetail items={items} width={width} height={height} empty={index.points.length < 3}
      emptySubject="index history" emptyTitle="No history available."
      renderChart={(chartHeight) => <HistoryChart row={row} width={width} height={chartHeight} focused={focused} />} />
  );
}

export function CdxPane({ focused, width, height }: PaneProps) {
  const theme = useThemeColors();
  const resource = useAsyncResource(loadCdxBoard, { initialData: getCachedCdxBoard });
  const { loading, load: refresh, reload } = resource;
  const payload = resource.data?.payload ?? null;
  const rows = useMemo(() => payload ? cdxRows(payload.indexes, payload.asOf) : EMPTY_ROWS, [payload]);
  // `CDX HY` opens on that index, named as `fn CDX HY` names it; a later `CDX IG` replaces it.
  const [selectedId, setSelectedId] = useCommandValue<string | null>(
    FIXED_INCOME_PANE_ID,
    "cdx:selected",
    (params) => params.view === "index" && params.index ? params.index : null,
    null,
  );
  const [openId, setOpenId] = usePluginPaneState<string | null>("cdx:open", null);
  useAutoRefresh(resource.updatedAt, refresh);
  usePaneRefreshKey(reload, { focused, enabled: !loading });

  const asOf = formatAsOf(payload?.asOf ?? null);
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(asOf ? [{ id: "as-of", parts: [{ text: `as of ${asOf}`, tone: "muted" as const }] }] : []),
    ...(payload ? [DELAYED_SEGMENT] : []),
    ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
  ], [asOf, payload, resource.data?.stale]);
  usePaneStatusFooter({
    registrationId: "cdx",
    loading,
    error: resource.error ?? resource.data?.refreshError ?? null,
    info,
  });

  // The 1W and 1M moves, HY and EM's price as a spread and the print count ride beside the board's own 1D column.
  const spreads = rows.some((row) => row.index.spreadBp !== undefined);
  const extraColumns = useMemo(() => [
    {
      column: { id: "week", label: "1W", width: 10, align: "right" as const },
      sortValue: (row: CdxRow) => row.week,
      renderCell: (row: CdxRow) => ({
        text: formatMove(row.index.quote, row.day.change1W),
        color: signedMoveColor(row.week, row.adverseMove, theme),
      }),
    },
    {
      column: { id: "month", label: "1M", width: 10, align: "right" as const },
      sortValue: (row: CdxRow) => row.month,
      renderCell: (row: CdxRow) => ({
        text: formatMove(row.index.quote, row.day.change1M),
        color: signedMoveColor(row.month, row.adverseMove, theme),
      }),
    },
    // A server that predates the spread equivalent sends none: no column of blanks.
    ...(spreads ? [{
      column: { id: "spread", label: "SPREAD EQ", width: 9, align: "right" as const },
      sortValue: (row: CdxRow) => row.index.quote === "price" ? row.index.spreadBp ?? null : null,
      renderCell: (row: CdxRow) => ({
        text: row.index.quote === "price" ? formatLevel("spread", row.index.spreadBp ?? null) : "--",
        color: theme.textMuted,
      }),
    }] : []),
    {
      column: { id: "prints", label: "PRINTS", width: 7, align: "right" as const },
      sortValue: (row: CdxRow) => row.index.prints,
      renderCell: (row: CdxRow) => ({
        text: row.index.prints == null ? "--" : String(row.index.prints),
        color: theme.textMuted,
      }),
    },
  ], [theme, spreads]);

  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={resource.error} empty={!loading && !resource.error}
        loadingLabel="Loading index CDS..." subject="Index CDS" align="center" width={width} height={height} />
    );
  }

  // The selected index's history sits above the board; the legend names it. What a command named (`HY`, `itraxx
  // main`) is read like `fn` reads it, and one the board does not have leaves the board on its first.
  const named = selectedId ? findIndex(payload?.indexes ?? [], selectedId) : null;
  const selected = rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === named?.id) ?? rows[0];
  return (
    <MarketBoardStack rows={rows} width={width} height={height} focused={focused}
      rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={rows.length}
        tableColumns={columns} chart={selected ? historyChart(selected) : null} />}
      selectedId={selected?.id ?? null} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
      labelHeader="INDEX" labelWidth={16} valueLabel="5Y" valueWidth={9} signedChange extraColumns={extraColumns}
      renderDetail={(row) => <IndexDetail row={row} width={width} height={Math.max(5, height - 2)} focused={focused} />} />
  );
}
