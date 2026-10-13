import { useCallback, useMemo } from "react";
import type { GasStorageRow } from "../../../api-client/europe-energy";
import {
  ChartTableHeader, CompositeChart, MarketBoardStack, PaneStatusBody, spanAxisFormatter, usePaneNoticeFooter, usePaneStatusFooter,
  type MarketBoardRow, type PaneHint, type StatItem,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { StatChartDetail } from "../../../components/market-board";
import { useAsyncResource, useAutoRefresh, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useRendererHost } from "../../../ui";
import { getCachedGasStorage, GAS_STORAGE_NOT_AVAILABLE, loadGasHistory, loadGasSeasonal, loadGasStorage, validateGasSeasonal, validateGasStorage } from "./gas-client";
import {
  formatGasFlow, formatGasFull, formatGasPoints, formatGasTwh, gasDayText, gasHistorySeries, gasRangeLabel, gasRangePosition,
  gasSeasonalSeries, gasStorageArea, gasYearAxis,
} from "./gas-model";
import { useGasStorageEvidence, type GasStorageSnapshot } from "./evidence";

const PANELS = [{ id: "main" }];
const formatAxis = spanAxisFormatter((value, digits) => `${value.toFixed(digits)}%`);
/** One decimal in a legend, so this year, last year and the average fit a phone's width. */
const formatLegend = (value: number) => `${value.toFixed(1)}%`;
/** EU first, as the server lists it. */
const DEFAULT_AREA = "EU";

interface GasBoardRow extends MarketBoardRow { gas: GasStorageRow }

function boardRow(row: GasStorageRow): GasBoardRow {
  const position = gasRangePosition(row);
  return {
    id: row.code, label: row.name, value: row.full, valueText: formatGasFull(row.full),
    change: row.change, changeText: formatGasPoints(row.change),
    percentile: position.value, percentileText: position.text,
    asOf: row.gasDay, asOfText: gasDayText(row), status: row.full == null ? "unavailable" : "available",
    history: row.trail.map((point) => ({ date: new Date(`${point.date}T00:00:00Z`), close: point.value })),
    gas: row,
  };
}

const column = (id: string, label: string, width: number, value: (row: GasStorageRow) => number | null, format: (value: number | null) => string) => ({
  column: { id, label, width, align: "right" as const },
  sortValue: (row: GasBoardRow) => value(row.gas),
  renderCell: (row: GasBoardRow) => {
    const current = value(row.gas);
    return { text: format(current), ...(current != null ? { value: current } : {}) };
  },
});
/** Against the range first, so a narrow board that scrolls still shows it beside the level. */
const EXTRA_COLUMNS = [
  column("five", "Vs 5Y", 8, (row) => row.fiveYear?.vsAverage ?? null, formatGasPoints),
  column("year", "Vs 1Y", 8, (row) => row.yearAgo?.change ?? null, formatGasPoints),
  column("twh", "TWh", 8, (row) => row.gasInStorage, formatGasTwh),
  column("injection", "Inj GWh/d", 10, (row) => row.injection, formatGasFlow),
  column("withdrawal", "Wdr GWh/d", 10, (row) => row.withdrawal, formatGasFlow),
];

/** An area's figures as of its gas day over its whole kept history. */
function GasDetail({ row, width, height, focused }: { row: GasStorageRow; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const loader = useCallback((force: boolean) => loadGasHistory(row.code, force), [row.code]);
  const history = useAsyncResource(loader, { keepPreviousData: true });
  const series = useMemo(() => history.data ? gasHistorySeries(history.data.payload, colors.positive) : [], [history.data, colors.positive]);
  const five = row.fiveYear;
  const items: StatItem[] = [
    { id: "full", label: "% full", value: formatGasFull(row.full), detail: gasDayText(row) },
    { id: "twh", label: "TWh", value: formatGasTwh(row.gasInStorage), ...(row.workingGasVolume != null ? { detail: `of ${formatGasTwh(row.workingGasVolume)}` } : {}) },
    { id: "injection", label: "Inject GWh/d", value: formatGasFlow(row.injection) },
    { id: "withdrawal", label: "Withdraw GWh/d", value: formatGasFlow(row.withdrawal) },
    { id: "change", label: "1D pp", value: formatGasPoints(row.change), ...(row.previousGasDay ? { detail: `vs ${row.previousGasDay}` } : {}) },
    { id: "year", label: "1Y ago %", value: formatGasFull(row.yearAgo?.full), ...(row.yearAgo ? { detail: row.yearAgo.gasDay } : {}) },
    { id: "range", label: `${gasRangeLabel(five?.years.length ?? 0)} range %`,
      value: five ? `${formatGasFull(five.min)} to ${formatGasFull(five.max)}` : "--",
      ...(five ? { detail: `avg ${formatGasFull(five.average)}${five.years.length < 5 ? `, ${five.years.length} of 5 years` : ""}` } : {}) },
  ];
  return <StatChartDetail items={items} width={width} height={height} empty={!history.loading && (series[0]?.points.length ?? 0) < 2}
    emptySubject="gas storage history" emptyTitle={history.error ?? "No gas storage history available."}
    renderChart={(chartHeight) => <CompositeChart series={series} panels={PANELS} width={width} height={chartHeight} focused={focused}
      showLegend navigable={false} showTimeAxis formatValue={formatLegend} formatAxisValue={formatAxis} remoteKind="gas-storage-history" />} />;
}

/**
 * POWER's Prices tab on its gas board: the EU aggregate and every member
 * state with storage as of its latest gas day, the selected area's year
 * against last year and its five-year range above the board, and its whole
 * kept history in the detail.
 */
export function GasStorageView({ width, height, focused, snapshot }: {
  width: number; height: number; focused: boolean; snapshot: GasStorageSnapshot | null;
}) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  // `EPWR GAS DE` opens on the area in the instance params; a saved selection wins.
  const params = usePaneInstance()?.params;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("power:prices:gas:selected", gasStorageArea(params?.area)?.code ?? null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("power:prices:gas:open", null);
  const frozen = useMemo(() => {
    try {
      return snapshot ? { board: validateGasStorage(snapshot.board), seasonal: snapshot.seasonal ? validateGasSeasonal(snapshot.seasonal) : null } : null;
    } catch { return null; }
  }, [snapshot]);
  const resource = useAsyncResource(frozen ? null : loadGasStorage, { initialData: getCachedGasStorage });
  const board = frozen?.board ?? resource.data?.payload ?? null;
  const rows = useMemo(() => board?.rows.map(boardRow) ?? [], [board]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === DEFAULT_AREA) ?? rows[0];
  const code = selected?.gas.gasDay ? selected.id : null;
  const seasonalLoader = useCallback((force: boolean) => loadGasSeasonal(code!, force), [code]);
  const loaded = useAsyncResource(code && !frozen ? seasonalLoader : null, { keepPreviousData: true });
  const seasonal = frozen ? frozen.seasonal : loaded.data?.payload ?? null;
  const seasonalLoading = !frozen && loaded.loading;
  useGasStorageEvidence(board, useMemo(() => rows.map((row) => row.id), [rows]), (!frozen && resource.loading) || seasonalLoading);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); void loaded.reload(); }, { focused });
  const open = rows.find((row) => row.id === openId);
  const series = useMemo(() => seasonal && seasonal.code === code ? gasSeasonalSeries(seasonal, colors, blendHex) : [], [seasonal, code, colors]);
  const year = seasonal?.code === code ? seasonal?.year : null;
  const axis = useMemo(() => year ? gasYearAxis(year) : null, [year]);
  const cursorDate = useMemo(() => selected?.gas.gasDay ? new Date(`${selected.gas.gasDay}T00:00:00Z`) : null, [selected?.gas.gasDay]);
  const notAvailable = !board && resource.error === GAS_STORAGE_NOT_AVAILABLE;
  const hints: PaneHint[] = [
    ...(board ? [{ id: "source", key: "o", label: `pen ${board.source.name}`, title: "Open the publisher's page",
      onPress: () => void host.openExternal(board.source.url) }] : []),
    ...(code ? [{ id: "chart", key: "g", label: "raph", title: "Chart in a custom chart",
      onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: `CAP:gas-storage:${code.toLowerCase()}` }) }] : []),
  ];
  usePaneStatusFooter({ registrationId: "power-gas", loading: (!frozen && resource.loading) || seasonalLoading,
    error: board ? (frozen ? null : resource.error ?? (open ? null : loaded.error)) : null, stale: !frozen && !!resource.data?.stale, hints });
  usePaneNoticeFooter({ registrationId: "power-gas:notices", focused,
    notices: [...(board?.gaps ?? []), ...(!frozen && resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  return <Box width={width} height={height} flexDirection="column">
    <PaneStatusBody loading={!frozen && resource.loading && !board} error={!board && !notAvailable ? resource.error : null}
      empty={notAvailable} emptyTitle={GAS_STORAGE_NOT_AVAILABLE} subject="gas storage" width={width} height={height}>
      {board ? <MarketBoardStack rows={rows} width={width} height={height} focused={focused}
        rootBefore={({ columns }) => <ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns}
          chart={selected ? { series, loading: seasonalLoading && !series.length, empty: `No gas storage range for ${selected.label}`,
            viewport: axis?.viewport, xAxis: axis?.xAxis, cursorDate, formatValue: formatLegend, formatAxisValue: formatAxis, remoteKind: "gas-storage-seasonal" } : null} />}
        selectedId={selected?.id ?? null} onSelectedIdChange={setSelectedId} openId={open?.id ?? null} onOpenIdChange={setOpenId}
        labelHeader="AREA" labelWidth={14} valueLabel="% FULL" valueWidth={8} changeLabel="1D PP" percentileLabel="IN 5Y"
        asOfWidth={14} extraColumns={EXTRA_COLUMNS} emptyTitle={GAS_STORAGE_NOT_AVAILABLE}
        renderDetail={(row) => <GasDetail row={row.gas} width={width} height={Math.max(5, height - 2)} focused={focused} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
