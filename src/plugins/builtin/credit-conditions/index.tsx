import { useMemo } from "react";
import {
  ChartTableHeader,
  CompositeChart,
  formatBpAxis,
  MarketBoardStack,
  PaneStatusBody,
  usePaneFooter,
  usePaneNoticeFooter,
  type MarketBoardRow,
  type PaneFooterSegment,
  type StatItem,
} from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { StatChartDetail } from "../../../components/market-board";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { formatPercentileRank } from "../../../utils/format";
import { usePluginPaneState } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { getCachedCreditConditions, loadCreditConditions } from "./client";
import { creditConditionsHeadless } from "./headless";
import { CREDIT_SERIES, type CreditConditionRow } from "./model";


const EMPTY_ROWS: CreditConditionRow[] = [];
const PANELS = [{ id: "main" }];

function formatBp(value: number | null, signed = false): string {
  if (value == null) return "--";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}bp`;
}

interface CreditBoardRow extends MarketBoardRow { spread: CreditConditionRow }

function boardRow(row: CreditConditionRow): CreditBoardRow {
  return {
    id: row.seriesId, label: row.label, value: row.oasBp, valueText: formatBp(row.oasBp),
    change: row.dailyChangeBp, changeText: formatBp(row.dailyChangeBp, true),
    percentile: row.percentile1Y, asOf: row.date, status: row.stale ? "stale" : "available",
    history: row.history.map((point) => ({ date: new Date(point.date), close: point.valueBp })),
    spread: row,
  };
}

function spreadHistorySeries(row: CreditConditionRow) {
  return [staticSeries(row.history.map((point) => ({
    date: new Date(point.date), observedAt: new Date(point.date), value: point.valueBp,
  })), { id: row.seriesId, label: `${row.label} OAS`, color: colors.positive, calendarSpaced: true })];
}

function spreadChart(row: CreditConditionRow) {
  return {
    series: spreadHistorySeries(row), formatValue: (value: number) => formatBp(value),
    formatAxisValue: formatBpAxis, remoteKind: "credit-spread-history",
    // An index without a history keeps the band, so the board does not jump under the cursor.
    empty: `No history for ${row.label}`,
  };
}

function SpreadChart({ row, width, height, focused }: { row: CreditConditionRow; width: number; height: number; focused: boolean }) {
  const series = useMemo(() => spreadHistorySeries(row), [row]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={formatBpAxis} remoteKind="credit-spread-history" />;
}

function SpreadDetail({ row, width, height, focused }: { row: CreditConditionRow; width: number; height: number; focused: boolean }) {
  // The chart shows the year the rank and range come from.
  const items: StatItem[] = [
    { id: "oas", label: "OAS", value: formatBp(row.oasBp),
      detail: `${formatPercentileRank(row.percentile1Y, "1Y")} · ${row.date}` },
    { id: "change", label: "1D", value: formatBp(row.dailyChangeBp, true) },
    { id: "range", label: "1Y range", value: `${formatBp(row.rangeLowBp)} to ${formatBp(row.rangeHighBp)}` },
    { id: "series", label: "FRED", value: row.seriesId, detail: row.frequency },
  ];
  return (
    <StatChartDetail items={items} width={width} height={height} empty={row.history.length < 2}
      emptySubject="spread history" emptyTitle="No spread history available."
      renderChart={(chartHeight) => <SpreadChart row={row} width={width} height={chartHeight} focused={focused} />} />
  );
}

export function CreditConditionsPane({ paneId, focused, width, height }: PaneProps) {
  const resource = useAsyncResource(loadCreditConditions, { initialData: getCachedCreditConditions });
  const { loading, load: refresh, reload } = resource;
  const stale = resource.data?.stale ?? false;
  const error = resource.error ?? resource.data?.errors[0] ?? null;
  const lastUpdated = stale ? null : resource.updatedAt;
  const rows = resource.data?.rows ?? EMPTY_ROWS;
  const boardRows = useMemo(() => rows.map(boardRow), [rows]);
  const mixedDates = new Set(rows.map((row) => row.date)).size > 1;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  // The shared FRED cache decides whether a tick actually hits the network, so
  // the pane can follow the global cadence without refetching daily data.
  useAutoRefresh(lastUpdated, refresh);

  usePaneRefreshKey(reload, { focused, enabled: !loading });
  const partial = rows.length > 0 && rows.length < CREDIT_SERIES.length;
  // Each row carries its own date in the AS OF column; a spread between
  // indexes from different sessions is a limitation behind the warning.
  usePaneNoticeFooter({
    registrationId: "credit-conditions:notices",
    focused,
    notices: mixedDates ? ["The indexes carry different observation dates, so the spreads are not one session."] : [],
  });
  const footerInfo = useMemo<PaneFooterSegment[]>(() => [
    ...(rows.length > 0 ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
    ...(partial ? [{ id: "partial", parts: [{ text: `PARTIAL ${rows.length}/${CREDIT_SERIES.length}`, tone: "warning" as const, bold: true }] }] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...loadingErrorFooterInfo(loading, error),
  ], [error, loading, partial, rows.length, stale]);
  usePaneFooter(paneId, () => ({ info: footerInfo }), [footerInfo, paneId]);

  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={error} empty={!loading && !error}
        loadingLabel="Loading credit spreads..." subject="Credit spreads" align="center" width={width} height={height} />
    );
  }

  // Like the funding boards, the selected index's year sits above the board;
  // the legend names the index, so the chart reads without the highlighted row.
  const selected = boardRows.find((row) => row.id === selectedId) ?? boardRows[0];
  return (
    <MarketBoardStack rows={boardRows} width={width} height={height} focused={focused}
      rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={boardRows.length}
        tableColumns={columns} chart={selected ? spreadChart(selected.spread) : null} />}
      selectedId={selectedId} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
      labelHeader="INDEX" labelWidth={10} valueLabel="OAS" valueWidth={10}
      renderDetail={(row) => <SpreadDetail row={row.spread} width={width} height={Math.max(5, height - 2)} focused={focused} />} />
  );
}

export const creditConditionsModule: PluginModule = {
  panes: [{
    id: "credit-conditions",
    name: "Credit Spreads",
    icon: "C",
    component: CreditConditionsPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 72, height: 18 },
  }],
  paneTemplates: [{
    id: "credit-conditions-pane",
    paneId: "credit-conditions",
    label: "Credit Spreads",
    description: "ICE BofA US corporate option-adjusted spreads from FRED.",
    keywords: ["credit", "spread", "oas", "corporate", "high yield", "investment grade", "macro"],
    shortcut: { prefix: "CRD" },
    headless: creditConditionsHeadless,
  }],
};
