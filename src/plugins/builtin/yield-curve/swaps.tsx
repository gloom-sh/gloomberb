import { useCallback, useMemo } from "react";
import type { SwapPoint } from "../../../api-client/swap-curve";
import {
  ChartTableHeader, CurveSurface, curveGhostColors, DataTableView, formatPercentAxis, QueryBar,
  useChartTableSelection, usePaneNoticeFooter, type ChartTableChart, type DataTableColumn,
} from "../../../components";
import { curveStrip, curveSurfaceMinRows } from "../../../components/chart/curve";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { FILL_REST } from "../../../components/ui/fill";
import { isAccessDenied } from "../../../api-client/errors";
import { usePluginPaneState } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box } from "../../../ui";
import { getCachedSwapCurve, loadSwapCurve } from "./client";
import { formatYield, formatYieldChange } from "./chart";
import { formatSwapBp, selectedSwapTenor, swapCurveSeries, swapHistorySeries } from "./swaps-model";

const COLUMNS: DataTableColumn[] = [
  { id: "tenor", label: "Tenor", width: 7, align: "left" },
  { id: "rate", label: "Rate %", width: 9, align: "right" },
  { id: "changeBp", label: "1D bp", width: 9, align: "right" },
  { id: "spreadBp", label: "Spread bp", width: 10, align: "right" },
  { id: "tradeCount", label: "Trades", width: 8, align: "right" },
  { id: "quality", label: "Sample", width: 9, align: "left" },
];
const EMPTY_ROWS: SwapPoint[] = [];
const tenorKey = (row: SwapPoint) => row.tenor;
const tenorPosition = (row: SwapPoint) => new Date(row.years * 86_400_000);

export function SwapsTab({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const colors = useThemeColors();
  const [selected, setSelected] = usePluginPaneState<string>("yield-curve:swap-tenor", "10Y");
  const [view, setView] = usePluginPaneState<"curve" | "history">("yield-curve:swap-view", "curve");
  const tenor = selectedSwapTenor(selected);
  const loader = useCallback((force: boolean) => loadSwapCurve(tenor, force), [tenor]);
  const resource = useAsyncResource(loader, {
    initialData: () => getCachedSwapCurve(tenor), keepPreviousData: true, clearOnError: isAccessDenied,
  });
  const payload = resource.data?.payload;
  const rows = payload?.points ?? EMPTY_ROWS;
  // A new tenor keeps the curve/table in place, but never relabels the old tenor's history.
  const history = payload?.history.tenor === tenor ? payload.history : null;
  const stale = payload?.stale || resource.data?.stale || false;
  const error = resource.error || resource.data?.refreshError || null;
  useAutoRefresh(stale ? null : resource.updatedAt, resource.load);
  usePaneRefreshKey(resource.reload, { focused });
  usePaneStatusFooter({ registrationId: "yield-curve:swaps", loading: resource.loading, error, stale });
  usePaneNoticeFooter({
    registrationId: "yield-curve:swaps:notices", focused,
    notices: payload ? [
      ...(!payload.comparisons.week.date ? ["The one-week comparison is unavailable."] : []),
      ...(!payload.comparisons.month.date ? ["The one-month comparison is unavailable."] : []),
      ...(!payload.treasuryDate ? ["Same-session Treasury yields are unavailable; swap spreads are blank."] : []),
    ] : [],
  });

  useChartTableSelection({ rows, getId: tenorKey, getDate: tenorPosition, selectedId: tenor, onSelect: setSelected, focused });
  const curve = useMemo(() => payload ? swapCurveSeries(payload, { current: colors.positive, ghosts: curveGhostColors(colors) }) : [],
    [payload, colors]);
  const historySeries = useMemo(() => history ? swapHistorySeries(history, colors.positive) : [], [history, colors.positive]);
  const strip = curveStrip(curve, formatYield, { caption: "SOFR %", selectedPointId: tenor });
  const chart: ChartTableChart | null = view === "history" ? {
    series: historySeries, formatValue: formatYield, formatAxisValue: formatPercentAxis,
    loading: resource.loading && !history, empty: `No history for ${tenor}`,
  } : strip ? {
    render: (size) => <CurveSurface series={curve} width={size.width} height={size.height} display="chart"
      caption="USD SOFR % by maturity" xScale="log" formatValue={formatYield} formatChange={formatYieldChange}
      formatAxisValue={formatPercentAxis} selectedPointId={tenor} onSelectedPointChange={setSelected} />,
    minRows: curveSurfaceMinRows({ series: curve, width, caption: "USD SOFR % by maturity" }), strip,
  } : null;
  const renderCell = useCallback((row: SwapPoint, column: DataTableColumn) => {
    if (column.id === "tenor") return { text: row.tenor };
    if (column.id === "quality") return { text: row.quality === "ok" ? "" : row.quality === "thin" ? "Thin" : "Missing",
      color: row.quality === "ok" ? colors.textMuted : colors.warning };
    if (column.id === "tradeCount") return { text: String(row.tradeCount), value: row.tradeCount,
      color: row.quality === "ok" ? undefined : colors.warning };
    const value = row[column.id as "rate" | "changeBp" | "spreadBp"];
    if (value == null) return { text: "--", color: colors.textMuted };
    if (column.id === "rate") return { text: formatYield(value), value };
    return { text: formatSwapBp(value), value,
      color: column.id === "changeBp" ? priceColor(Math.round(value * 10), colors) : undefined };
  }, [colors]);

  return <Box flexDirection="column" width={width} height={height} {...FILL_REST}>
    <DataTableView<SwapPoint> focused={focused} rootWidth={width} rootHeight={height}
      columns={COLUMNS} items={rows} getItemKey={tenorKey} renderCell={renderCell} selectedTextOverridesCellColor
      selection={{ kind: "id", selectedId: tenor, getId: tenorKey, onChange: setSelected }}
      onActivate={(row) => { setSelected(row.tenor); setView("history"); }} sortColumnId={null} sortDirection="asc"
      emptyStateTitle="No swap rates yet."
      status={{ loading: resource.loading && !payload, error: !payload ? error : null,
        loadingLabel: "Loading swap rates...", subject: "swap rates", retry: { onRetry: resource.reload, pending: resource.loading } }}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={COLUMNS}
        query={<QueryBar width={width}
          view={{ value: view, options: [{ value: "curve", label: "Curve" }, { value: "history", label: "History" }], onChange: setView }}
          asOf={payload?.asOf ? `as of ${payload.asOf}` : undefined} />}
        chart={chart} />} />
  </Box>;
}
