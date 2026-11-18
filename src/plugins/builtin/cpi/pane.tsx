import { useCallback, useMemo } from "react";
import type { CpiBoardPayload, CpiRow } from "../../../api-client/cpi";
import {
  ChartRead,
  ChartTableHeader,
  CompositeChart,
  DataTableView,
  formatPercentAxis,
  PaneStatusBody,
  QueryBar,
  useChartReadRows,
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
import { Box, TextAttributes } from "../../../ui";
import { fitTableColumns, getTableWidth, hasMeaningfulTableHorizontalOverflow } from "../../../components/ui/table-layout";
import { displayWidth } from "../../../utils/format";
import { nextHeaderSort } from "../../../utils/sort-values";
import { CPI_NOT_AVAILABLE, getCachedCpiBoard, loadCpiBoard } from "./client";
import {
  CPI_TABLE_ORDER,
  cpiChartSeries,
  cpiChartStrip,
  cpiHeadlineYearGapLine,
  cpiMonthDate,
  cpiNextRelease,
  cpiReleaseStamp,
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
const YOY_POINTS_COLUMN = {
  id: "contributionYoy", label: "Y/Y Pts", width: 8, align: "right", flexGrow: 1, omitWhenEmpty: true, format: formatCpiPoints,
} as const;
const FIGURE_COLUMNS = [
  { id: "weight", label: "Wgt", width: 6, align: "right", flexGrow: 1, format: formatCpiWeight },
  { id: "change", label: "M/M", width: 7, align: "right", flexGrow: 1, format: formatCpiChange },
  { id: "annualized3m", label: "3M Ann", width: 7, align: "right", flexGrow: 1, format: formatCpiChange },
  { id: "annualized6m", label: "6M Ann", width: 7, align: "right", flexGrow: 1, format: formatCpiChange },
  { id: "yoy", label: "Y/Y", width: 7, align: "right", flexGrow: 1, format: formatCpiChange },
  { id: "contribution", label: "M/M Pts", width: 8, align: "right", flexGrow: 1, format: formatCpiPoints },
  YOY_POINTS_COLUMN,
] as const;
type CpiColumn = DataTableColumn & (
  { id: "name" } | { id: (typeof FIGURE_COLUMNS)[number]["id"]; format: typeof formatCpiChange }
);
/** The names' widest, and the narrowest they are cut to before the figures scroll. */
const NAME_WIDTH = 22;
const NAME_MIN_WIDTH = 10;

/**
 * The columns at a pane's width: the name takes the room the figures leave, up
 * to its full width. When even the shortest name leaves too little room, fit
 * the blank space out of the figures before the first frame. A column with no
 * annual points does not take up room, but is still exported by the table.
 */
function cpiColumns(width: number, rows: readonly CpiRow[]): CpiColumn[] {
  const yoyPoints = rows.some((row) => row.contributionYoy != null);
  const figures = yoyPoints ? FIGURE_COLUMNS : FIGURE_COLUMNS.filter((column) => column.id !== "contributionYoy");
  const room = width - getTableWidth(figures) - 1;
  const shown: CpiColumn[] = [
    { id: "name", label: "Component", width: Math.max(NAME_MIN_WIDTH, Math.min(NAME_WIDTH, room)), align: "left", flexGrow: 4 },
    ...figures,
  ];
  const fitted = hasMeaningfulTableHorizontalOverflow(getTableWidth(shown), width)
    ? fitTableColumns(shown, [null, ...figures.map((column) => rows.reduce(
      (widest, row) => Math.max(widest, displayWidth(column.format(row[column.id]))), 0,
    ))], width)
    : shown;
  return yoyPoints ? fitted : [...fitted, YOY_POINTS_COLUMN];
}
const PANELS = [{ id: "main" }];
/** Legend, four plot rows and the time axis; the read under them takes its own rows. */
const CHART_ROWS_ABOVE_READ = 6;

/** Legend values in the table's units: changes in percent. */
const legendValue = (value: number) => `${value.toFixed(2)}%`;

/**
 * The selected row's monthly changes as columns and its year over year as a
 * line, with the headline's year over year for reference. The cursor rests on
 * the latest month so the legend reads it; the plain read sits under the axis.
 */
function CpiChart({ row, series, width, height }: { row: CpiRow; series: ResolvedSeries[]; width: number; height: number }) {
  const latest = row.history.at(-1)?.[0] ?? null;
  const axis = useMemo(() => cpiTimeAxis(row.history), [row.history]);
  // The plain read under the axis: wrapped in the terminal, cut by CSS where its line ends on the desktop.
  const readRows = useChartReadRows([row.read], width);
  return (
    <Box width={width} height={height} flexDirection="column">
      <CompositeChart series={series} panels={PANELS} width={width} height={Math.max(3, height - readRows)}
        focused={false} navigable={false} showLegend showTimeAxis cursorDate={latest ? cpiMonthDate(latest) : null}
        viewport={axis?.viewport} xAxis={axis?.xAxis} clipToViewport={!!axis}
        formatValue={legendValue} formatAxisValue={formatPercentAxis} remoteKind="cpi-component-history" />
      <ChartRead text={row.read} width={width} />
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
  // The release stays whole in a narrow pane; when the next one is due gives way first.
  const stamp = cpiReleaseStamp(payload.release);
  const next = cpiNextRelease(payload.release);
  const columns = useMemo(() => cpiColumns(width, rows), [rows, width]);
  // Room for the longest read at this width, so the chart does not give way to the strip as the selection moves.
  const readRows = useChartReadRows(rows.map((row) => row.read), width);
  const chart: ChartTableChart | null = selected ? {
    render: (size) => <CpiChart row={selected} series={series} width={size.width} height={size.height} />,
    minRows: CHART_ROWS_ABOVE_READ + Math.max(1, readRows),
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
    <DataTableView<CpiRow, CpiColumn> columns={columns} items={rows} focused={focused} rootWidth={width} rootHeight={height}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns}
        query={stamp ? <QueryBar width={width} asOf={stamp} meta={next} /> : undefined} chart={chart} />}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelectedId }}
      onActivate={(row) => setSelectedId(row.id)} getItemKey={(row) => row.id}
      sortColumnId={sort.columnId} sortDirection={sort.direction} onHeaderClick={onHeaderClick}
      onSortChange={(columnId, direction) => setSort(isCpiSortColumn(columnId) ? { columnId, direction } : CPI_TABLE_ORDER)}
      isColumnSortable={(column) => column.id !== "name"}
      resetScrollKey={`${sort.columnId}:${sort.direction}`}
      selectedTextOverridesCellColor
      renderCell={(row, column) => {
        if (column.id === "name") {
          return { text: cpiRowLabel(row, hierarchy), value: row.label,
            color: row.pinned || (hierarchy && row.depth === 0) ? colors.textBright : colors.text,
            attributes: row.pinned ? TextAttributes.BOLD : undefined };
        }
        const value = row[column.id];
        const text = column.format(value);
        return column.id === "weight" ? { text, value, color: colors.textMuted } : signedCell(value, text);
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
  usePaneRefreshKey(() => resource.reload(), { focused });
  usePaneNoticeFooter({ registrationId: "cpi:notices", focused,
    notices: [...(data?.gaps ?? []), ...(data ? [cpiHeadlineYearGapLine(data)].filter((line): line is string => !!line) : []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
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
