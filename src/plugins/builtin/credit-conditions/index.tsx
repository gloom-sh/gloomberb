import { useMemo } from "react";
import {
  CompositeChart,
  MarketBoardStack,
  PaneStatusBody,
  StatGrid,
  statGridRows,
  usePaneFooter,
  usePaneNoticeFooter,
  type MarketBoardRow,
  type PaneFooterSegment,
  type StatItem,
} from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { usePluginPaneState } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { useAutoRefresh } from "../shared/auto-refresh";
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

function SpreadChart({ row, width, height, focused }: { row: CreditConditionRow; width: number; height: number; focused: boolean }) {
  const series = useMemo(() => [staticSeries(row.history.map((point) => ({
    date: new Date(point.date), observedAt: new Date(point.date), value: point.valueBp,
  })), { id: row.seriesId, label: row.label, color: colors.positive, calendarSpaced: true })], [row]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={(value) => formatBp(value)} remoteKind="credit-spread-history" />;
}

function SpreadDetail({ row, width, height, focused }: { row: CreditConditionRow; width: number; height: number; focused: boolean }) {
  // The chart shows the year the rank and range come from.
  const items: StatItem[] = [
    { id: "oas", label: "OAS", value: formatBp(row.oasBp),
      detail: `${row.percentile1Y == null ? "--" : row.percentile1Y.toFixed(0)} pctl 1Y · ${row.date}` },
    { id: "change", label: "1D", value: formatBp(row.dailyChangeBp, true) },
    { id: "range", label: "1Y range", value: `${formatBp(row.rangeLowBp)} to ${formatBp(row.rangeHighBp)}` },
    { id: "series", label: "FRED", value: row.seriesId, detail: row.frequency },
  ];
  const statRows = statGridRows(items, width);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <StatGrid items={items} width={width} />
      <PaneStatusBody empty={row.history.length < 2} subject="spread history" emptyTitle="No spread history available.">
        <SpreadChart row={row} width={width} height={Math.max(3, height - statRows)} focused={focused} />
      </PaneStatusBody>
    </Box>
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

  useShortcut((event) => {
    if (!focused || !isPlainKey(event, "r") || loading) return;
    reload();
    event.preventDefault?.();
    event.stopPropagation?.();
  });
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
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ], [error, loading, partial, rows.length, stale]);
  usePaneFooter(paneId, () => ({ info: footerInfo }), [footerInfo, paneId]);

  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={error} empty={!loading && !error}
        loadingLabel="Loading credit spreads..." subject="Credit spreads" align="center" width={width} height={height} />
    );
  }

  // Like the funding boards, the selected index's year fills the space above the board.
  const selected = boardRows.find((row) => row.id === selectedId) ?? boardRows[0];
  const boardHeight = Math.max(3, Math.min(boardRows.length + 2, Math.floor(height * 0.45)));
  const chartHeight = height - boardHeight;
  const detailOpen = boardRows.some((row) => row.id === openId);
  return (
    <MarketBoardStack rows={boardRows} width={width} height={height} focused={focused}
      rootBefore={selected && selected.spread.history.length >= 2 && chartHeight >= 8
        ? <SpreadChart row={selected.spread} width={width} height={chartHeight} focused={focused && !detailOpen} /> : undefined}
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
