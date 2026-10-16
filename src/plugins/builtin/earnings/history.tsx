import { useCallback, useMemo } from "react";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  formatPercentAxis,
  useChartTableSelection,
  usePaneStatusFooter,
  type ChartTableChart,
} from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { colors } from "../../../theme/colors";
import { useAssetData } from "../../runtime";
import { newYorkToday } from "./board-model";
import { cachedEarningsHistory, loadEarningsHistory } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { chartAxis, chartPoints, chartRows, historyFigures, historyRows, type HistoryRow } from "./history-model";
import { historyColumns, renderHistoryCell, type HistoryColumn } from "./history-table";
import { loadNoEarningsText } from "./no-earnings";
import { listingAbroadVenue } from "../../../utils/sec";

const barDate = (row: HistoryRow) => (row.implied != null || row.move != null ? new Date(`${row.date}T00:00:00Z`) : null);

/**
 * One company's reports: the upcoming one, then up to twelve quarters with
 * estimates against actuals, the move priced before and the move after. The
 * pane for `ERN <ticker>` and the detail a board row opens.
 */
export function EarningsHistoryView({ symbol, width, height, focused, registrationId }: {
  symbol: string;
  width: number;
  height: number;
  focused: boolean;
  registrationId: string;
}) {
  const dataProvider = useAssetData();
  // Past reports are the US board's, where SAN is not SAN:EPA's company: a listing abroad shows its next report alone.
  const abroad = listingAbroadVenue(symbol) != null;
  const loader = useCallback((force: boolean) => (abroad ? Promise.resolve(null) : loadEarningsHistory(symbol, force)), [abroad, symbol]);
  const resource = useAsyncResource(loader, { initialData: () => (abroad ? null : cachedEarningsHistory(symbol)) });
  // Past the stored calendar's horizon, and for listings it does not carry, the per-ticker calendar has the next date.
  const upcomingLoader = useCallback(
    (force: boolean) => loadEarningsCalendar(dataProvider, [symbol], { force }).then((result) => result.events[0] ?? null),
    [dataProvider, symbol],
  );
  const upcoming = useAsyncResource(upcomingLoader);
  const payload = resource.data?.payload ?? null;
  const today = newYorkToday();
  const rows = useMemo(() => historyRows(payload, today, upcoming.data ?? null), [payload, today, upcoming.data]);
  const columns = useMemo(() => historyColumns(width, rows), [rows, width]);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`history:${symbol}:selected`, null);
  const selected = rows.find((row) => row.key === selectedId) ?? rows[0] ?? null;
  const bars = useMemo(() => chartRows(rows), [rows]);
  // Named as the table names them; the bars are sizes, the MOVE column keeps the direction.
  const series = useMemo(() => bars.length < 2 ? [] : [
    staticSeries(chartPoints(bars, (row) => row.implied), { id: "implied", label: "Implied", color: colors.borderFocused, style: "columns" }),
    staticSeries(chartPoints(bars, (row) => (row.move == null ? null : Math.abs(row.move))), { id: "move", label: "Move", color: colors.warning, style: "columns" }),
  ], [bars]);
  const axis = useMemo(() => chartAxis(bars), [bars]);
  const link = useChartTableSelection({
    rows, getId: (row) => row.key, getDate: barDate, selectedId: selected?.key ?? null, onSelect: setSelectedId, focused,
  });
  const figures = useMemo(() => historyFigures(rows, today), [rows, today]);
  // The upcoming report has no bar until it is priced; the legend then reads the latest report's.
  const latestBar = bars.at(-1);
  const cursorDate = link.cursorDate ?? (latestBar ? barDate(latestBar) : null);
  const chart = useMemo<ChartTableChart | null>(() => series.length ? {
    series, xAxis: axis, formatValue: (value) => `${value.toFixed(1)}%`, formatAxisValue: formatPercentAxis,
    remoteKind: "earnings-moves", ...link, cursorDate,
  } : null, [axis, cursorDate, link, series]);
  // A symbol with no reports on record may be one that never has any (an ETF, an index, a coin): its type says so.
  const bare = !resource.loading && rows.length === 0;
  const noEarningsLoader = useCallback(() => (dataProvider ? loadNoEarningsText(dataProvider, symbol, "pane") : Promise.resolve(null)), [dataProvider, symbol]);
  const noEarnings = useAsyncResource(bare && !abroad ? noEarningsLoader : null);
  const emptyTitle = noEarnings.data ?? "No earnings reports on record.";
  // A coin's history fails (it is no US ticker), which says nothing once its type has answered.
  const historyError = noEarnings.loading || noEarnings.data ? null : resource.error;
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); void upcoming.reload(); }, { focused });
  usePaneStatusFooter({
    registrationId,
    loading: resource.loading,
    error: historyError,
    stale: !!resource.data?.stale,
    info: abroad ? [{ id: "us-listings", parts: [{ text: "past reports: US listings only", tone: "muted" as const }] }]
      : payload && updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : [],
  });

  return (
    <PaneStatusBody
      loading={(resource.loading && !payload && rows.length === 0) || noEarnings.loading}
      error={!payload && rows.length === 0 ? historyError : null}
      empty={bare}
      emptyTitle={emptyTitle}
      subject="earnings history"
    >
      <DataTableView<HistoryRow, HistoryColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={height}
        columns={columns}
        items={rows}
        getItemKey={(row) => row.key}
        renderCell={renderHistoryCell}
        selectedTextOverridesCellColor
        sortColumnId={null}
        sortDirection="desc"
        resetScrollKey={symbol}
        selection={{ kind: "index", selectedIndex: selected ? rows.indexOf(selected) : -1, onChange: (index) => setSelectedId(rows[index]?.key ?? null) }}
        onActivate={(row) => setSelectedId(row.key)}
        emptyStateTitle={emptyTitle}
        rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns} figures={figures} chart={chart} />}
      />
    </PaneStatusBody>
  );
}
