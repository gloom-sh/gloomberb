import { useCallback, useMemo } from "react";
import {
  ChartTableHeader,
  CompositeChart,
  formatBpAxis,
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
import { useAssetData, usePluginPaneState } from "../../runtime";
import { formatAsOf } from "../cds/model";
import { getCachedSovrBoard, loadCurrencyMoves, loadSovrBoard } from "./client";
import {
  formatContract,
  formatCurrencyMove,
  formatLevel,
  formatMove,
  sovrRows,
  type SovrRow,
} from "./model";

const PANELS = [{ id: "main" }];
const EMPTY_ROWS: SovrRow[] = [];
const NO_MOVES = new Map<string, number | null>();

function historySeries(row: SovrRow) {
  return [staticSeries(row.sovereign.points.map((point) => ({
    date: new Date(`${point.date}T00:00:00Z`), observedAt: new Date(`${point.date}T00:00:00Z`), value: point.level,
  })), { id: row.id, label: `${row.label} 5Y`, color: colors.positive, calendarSpaced: true })];
}

function historyChart(row: SovrRow): ChartTableChart {
  return {
    series: row.sovereign.points.length >= 3 ? historySeries(row) : [],
    formatValue: (value: number) => formatLevel("spread", value),
    formatAxisValue: formatBpAxis,
    remoteKind: "sovr-history",
    empty: `No history for ${row.label}`,
  };
}

function HistoryChart({ row, width, height, focused }: { row: SovrRow; width: number; height: number; focused: boolean }) {
  const series = useMemo(() => historySeries(row), [row]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} showLegend={false}
    navigable={false} showTimeAxis formatAxisValue={formatBpAxis} remoteKind="sovr-history" />;
}

function SovereignDetail({ row, width, height, focused }: { row: SovrRow; width: number; height: number; focused: boolean }) {
  const { sovereign, year } = row;
  const items: StatItem[] = [
    { id: "level", label: "5Y spread", value: formatLevel("spread", sovereign.level),
      detail: `${formatPercentileRank(year.percentile, "1Y")} · ${sovereign.date}` },
    { id: "1m", label: "1M", value: formatMove("spread", sovereign.change1M) },
    { id: "1w", label: "1W", value: formatMove("spread", sovereign.change1W) },
    { id: "fx", label: "Currency 1M", value: formatCurrencyMove(sovereign.currency, row.currencyMove) },
    { id: "range", label: "1Y range", value: `${formatLevel("spread", year.low)} to ${formatLevel("spread", year.high)}` },
    { id: "contract", label: "Contract", value: formatContract(sovereign.maturity),
      detail: `${sovereign.prints} prints, ${sovereign.reported} with spread` },
  ];
  return (
    <StatChartDetail items={items} width={width} height={height} empty={sovereign.points.length < 3}
      emptySubject="spread history" emptyTitle="No history available."
      renderChart={(chartHeight) => <HistoryChart row={row} width={width} height={chartHeight} focused={focused} />} />
  );
}

export function SovrPane({ focused, width, height }: PaneProps) {
  const theme = useThemeColors();
  const provider = useAssetData();
  const resource = useAsyncResource(loadSovrBoard, { initialData: getCachedSovrBoard });
  const { loading, load: refresh, reload } = resource;
  const payload = resource.data?.payload ?? null;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("sovr:selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("sovr:open", null);
  useAutoRefresh(resource.updatedAt, refresh);

  // Each currency's month against the dollar, from the same daily closes the FX panes use.
  const currencies = useMemo(() => [...new Set(payload?.sovereigns.map((row) => row.currency) ?? [])].sort().join(","),
    [payload]);
  const movesLoader = useCallback(() => provider && currencies
    ? loadCurrencyMoves(currencies.split(","), (symbol) => provider.getPriceHistory(symbol, "", "3M"))
    : Promise.resolve(NO_MOVES), [currencies, provider]);
  const moves = useAsyncResource(movesLoader, { keepPreviousData: true });
  const rows = useMemo(() => payload ? sovrRows(payload.sovereigns, payload.asOf, moves.data ?? NO_MOVES) : EMPTY_ROWS,
    [moves.data, payload]);
  usePaneRefreshKey(() => {
    reload();
    moves.reload();
  }, { focused, enabled: !loading });

  const asOf = formatAsOf(payload?.asOf ?? null);
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(asOf ? [{ id: "as-of", parts: [{ text: `as of ${asOf}`, tone: "muted" as const }] }] : []),
    ...(payload ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
    ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
  ], [asOf, payload, resource.data?.stale]);
  usePaneStatusFooter({
    registrationId: "sovr",
    loading: loading || moves.loading,
    error: resource.error ?? resource.data?.refreshError ?? null,
    info,
  });

  const movesPending = moves.loading && !moves.data;
  const extraColumns = useMemo(() => [{
    column: { id: "currency", label: "CCY 1M", width: 11, align: "right" as const },
    sortValue: (row: SovrRow) => row.currencyMove,
    renderCell: (row: SovrRow) => ({
      text: movesPending ? `${row.sovereign.currency} ...` : formatCurrencyMove(row.sovereign.currency, row.currencyMove),
      // A weaker local currency is the adverse move.
      color: signedMoveColor(row.currencyMove, "down", theme),
    }),
  }], [movesPending, theme]);

  if (rows.length === 0) {
    return (
      <PaneStatusBody loading={loading} error={resource.error} empty={!loading && !resource.error}
        loadingLabel="Loading sovereign CDS..." subject="Sovereign CDS" align="center" width={width} height={height} />
    );
  }

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  return (
    <MarketBoardStack rows={rows} width={width} height={height} focused={focused}
      rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={rows.length}
        tableColumns={columns} chart={selected ? historyChart(selected) : null} />}
      selectedId={selectedId} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
      labelHeader="SOVEREIGN" labelWidth={18} valueLabel="5Y" valueWidth={9} changeLabel="1M" signedChange
      extraColumns={extraColumns}
      renderDetail={(row) => <SovereignDetail row={row} width={width} height={Math.max(5, height - 2)} focused={focused} />} />
  );
}
