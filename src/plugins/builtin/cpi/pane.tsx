import { useCallback, useMemo } from "react";
import type { CpiBoardPayload, CpiRow } from "../../../api-client/cpi";
import {
  ChartTableHeader,
  CompositeChart,
  DataTableView,
  formatPercentAxis,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type ChartTableChart,
  type DataTableColumn,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes } from "../../../ui";
import { truncateToDisplayWidth } from "../../../utils/format";
import { nextHeaderSort } from "../../../utils/sort-values";
import { CPI_NOT_AVAILABLE, getCachedCpiBoard, loadCpiBoard } from "./client";
import {
  CPI_TABLE_ORDER,
  cpiChartSeries,
  cpiChartStrip,
  cpiHeaderLine,
  cpiMonthDate,
  cpiRowLabel,
  cpiRows,
  cpiTimeAxis,
  formatCpiChange,
  formatCpiPoints,
  formatCpiWeight,
  isCpiSortColumn,
  type CpiSort,
} from "./model";

// The figures share the width a wide pane adds with the names, so they do not
// huddle at the right edge; in the terminal the name column takes it all.
const COLUMNS: DataTableColumn[] = [
  { id: "name", label: "Component", width: 22, align: "left", flexGrow: 4 },
  { id: "weight", label: "Wgt", width: 6, align: "right", flexGrow: 1 },
  { id: "change", label: "M/M", width: 7, align: "right", flexGrow: 1 },
  { id: "annualized3m", label: "3M Ann", width: 7, align: "right", flexGrow: 1 },
  { id: "annualized6m", label: "6M Ann", width: 7, align: "right", flexGrow: 1 },
  { id: "yoy", label: "Y/Y", width: 7, align: "right", flexGrow: 1 },
  { id: "contribution", label: "M/M Pts", width: 8, align: "right", flexGrow: 1 },
  { id: "contributionYoy", label: "Y/Y Pts", width: 8, align: "right", flexGrow: 1 },
];
const PANELS = [{ id: "main" }];
/** Legend, four plot rows, the time axis and the read under it. */
const CHART_MIN_ROWS = 7;

/** Legend values in the table's units: changes in percent. */
const legendValue = (value: number) => `${value.toFixed(2)}%`;

/**
 * The selected row's monthly changes as columns and its year over year as a
 * line, with the headline's year over year for reference. The cursor rests on
 * the latest month so the legend reads it; the plain read sits under the axis.
 */
function CpiChart({ row, series, width, height }: { row: CpiRow; series: ResolvedSeries[]; width: number; height: number }) {
  const colors = useThemeColors();
  const latest = row.history.at(-1)?.[0] ?? null;
  const axis = useMemo(() => cpiTimeAxis(row.history), [row.history]);
  const read = row.read ? truncateToDisplayWidth(row.read, Math.max(0, width - 2)) : "";
  return (
    <Box width={width} height={height} flexDirection="column">
      <CompositeChart series={series} panels={PANELS} width={width} height={Math.max(3, height - (read ? 1 : 0))}
        focused={false} navigable={false} showLegend showTimeAxis cursorDate={latest ? cpiMonthDate(latest) : null}
        viewport={axis?.viewport} xAxis={axis?.xAxis} clipToViewport={!!axis}
        formatValue={legendValue} formatAxisValue={formatPercentAxis} remoteKind="cpi-component-history" />
      {read ? <Box height={1} paddingX={1}><Text fg={colors.textMuted}>{read}</Text></Box> : null}
    </Box>
  );
}

function CpiBoard({ payload, initialRow, width, height, focused }: {
  payload: CpiBoardPayload; initialRow: string | null; width: number; height: number; focused: boolean;
}) {
  const colors = useThemeColors();
  const [sort, setSort] = usePluginPaneState<CpiSort>("sort", CPI_TABLE_ORDER);
  const rows = useMemo(() => cpiRows(payload, sort), [payload, sort]);
  const hierarchy = sort.columnId == null;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", initialRow);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const headline = payload.rows.find((row) => row.code === "SA0") ?? null;
  const series = useMemo(() => selected ? cpiChartSeries(selected, headline, colors) : [], [selected, headline, colors]);
  const meta = cpiHeaderLine(payload.release);
  const chart: ChartTableChart | null = selected ? {
    render: (size) => <CpiChart row={selected} series={series} width={size.width} height={size.height} />,
    minRows: CHART_MIN_ROWS,
    strip: cpiChartStrip(selected, colors.warning),
    empty: series.length ? undefined : `No history for ${selected.label}`,
  } : null;
  // A header click sorts largest first, then smallest, then back to the release's order.
  const onHeaderClick = useCallback((columnId: string) => setSort((current) => (isCpiSortColumn(columnId)
    ? nextHeaderSort(current, columnId, { firstDirection: "desc", resetTo: CPI_TABLE_ORDER })
    : CPI_TABLE_ORDER)), [setSort]);
  const signedCell = (value: number | null, text: string) => ({
    text, value, color: value == null || Number(text) === 0 ? colors.textDim : priceColor(value, colors),
  });
  return (
    <DataTableView<CpiRow> columns={COLUMNS} items={rows} focused={focused} rootWidth={width} rootHeight={height}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={COLUMNS}
        query={meta ? <QueryBar width={width} meta={meta} /> : undefined} chart={chart} />}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelectedId }}
      onActivate={(row) => setSelectedId(row.id)} getItemKey={(row) => row.id}
      sortColumnId={sort.columnId} sortDirection={sort.direction} onHeaderClick={onHeaderClick}
      onSortChange={(columnId, direction) => setSort(isCpiSortColumn(columnId) ? { columnId, direction } : CPI_TABLE_ORDER)}
      isColumnSortable={(column) => column.id !== "name"}
      resetScrollKey={`${sort.columnId}:${sort.direction}`}
      selectedTextOverridesCellColor
      renderCell={(row, column) => {
        switch (column.id) {
          case "name":
            return { text: cpiRowLabel(row, hierarchy), value: row.label,
              color: row.pinned || (hierarchy && row.depth === 0) ? colors.textBright : colors.text,
              attributes: row.pinned ? TextAttributes.BOLD : undefined };
          case "weight": return { text: formatCpiWeight(row.weight), value: row.weight, color: colors.textMuted };
          case "change": return signedCell(row.change, formatCpiChange(row.change));
          case "annualized3m": return signedCell(row.annualized3m, formatCpiChange(row.annualized3m));
          case "annualized6m": return signedCell(row.annualized6m, formatCpiChange(row.annualized6m));
          case "yoy": return signedCell(row.yoy, formatCpiChange(row.yoy));
          case "contribution": return signedCell(row.contribution, formatCpiPoints(row.contribution));
          default: return signedCell(row.contributionYoy, formatCpiPoints(row.contributionYoy));
        }
      }}
      emptyStateTitle="No components in this release yet." />
  );
}

export function CpiPane({ width, height, focused }: PaneProps) {
  const initialRow = usePaneInstance()?.params?.row ?? null;
  const resource = useAsyncResource(loadCpiBoard, { initialData: getCachedCpiBoard });
  const data = resource.data?.payload ?? null;
  // The server not serving the board yet is a state of the data, not a failure.
  const notAvailable = !data && resource.error === CPI_NOT_AVAILABLE;
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneNoticeFooter({ registrationId: "cpi:notices", focused,
    notices: [...(data?.gaps ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusFooter({ registrationId: "cpi", loading: resource.loading, error: notAvailable ? null : resource.error,
    stale: !!data && resource.data?.stale });
  return (
    <Box width={width} height={height} flexDirection="column">
      <PaneStatusBody loading={resource.loading && !data} error={!data && !notAvailable ? resource.error : null}
        empty={notAvailable} emptyTitle={CPI_NOT_AVAILABLE} subject="US consumer prices">
        {data ? <CpiBoard payload={data} initialRow={initialRow} width={width} height={height} focused={focused} /> : null}
      </PaneStatusBody>
    </Box>
  );
}
