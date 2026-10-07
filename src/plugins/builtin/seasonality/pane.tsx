import { useCallback, useEffect, useMemo, useRef } from "react";
import { CompositeChart, DataTableView, EmptyState, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneFooter,
  usePaneNoticeFooter, usePaneTabs, usePaneTicker, type DataTableCell, type DataTableColumn, type StatItem } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { staticSeries } from "../../../components/chart/static/series";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { blendHex } from "../../../theme/color-utils";
import { resolveHeatCellColors } from "../../../theme/heat-colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { loadSeasonalityHistory } from "./client";
import { MONTH_LABELS, OVERLAY_YEAR, projectSeasonality, type SeasonalityModel } from "./model";

const TABS = [{ value: "returns", label: "Returns" }, { value: "overlay", label: "Overlay" }];
export const LOOKBACK_OPTIONS = [{ value: "5", label: "5Y" }, { value: "10", label: "10Y" }, { value: "20", label: "20Y" }];
/** The move that tints a cell at full strength: a month of ±10%, a year of ±30%. */
const MONTH_SCALE = 0.1, YEAR_SCALE = 0.3;
function pct(value: number | null | undefined): string {
  if (value == null) return "--";
  const fixed = (value * 100).toFixed(1);
  // A return that rounds to zero reads 0.0%, never -0.0%.
  return /[1-9]/.test(fixed) ? `${value > 0 ? "+" : ""}${fixed}%` : "0.0%";
}

interface Row { id: string; label: string; cells: (number | null)[]; total: number | null; kind: "stat" | "hit" | "year"; partial?: boolean }

const COLUMNS: DataTableColumn[] = [
  { id: "label", label: "Year", width: 7, align: "left" },
  ...MONTH_LABELS.map((label, month) => ({ id: `m${month}`, label, width: 7, align: "right" as const })),
  { id: "total", label: "Year %", width: 8, align: "right" },
];

function tableRows(model: SeasonalityModel): Row[] {
  return [
    { id: "mean", label: "Avg", kind: "stat", cells: model.months.map((stat) => stat.mean), total: null },
    { id: "median", label: "Median", kind: "stat", cells: model.months.map((stat) => stat.median), total: null },
    { id: "hit", label: "Up %", kind: "hit", cells: model.months.map((stat) => stat.hitRate), total: null },
    ...model.years.map((year): Row => ({ id: String(year.year), label: `${year.year}${year.partial ? "*" : ""}`, kind: "year",
      cells: year.months, total: year.total, partial: year.partial })),
  ];
}

function renderCell(row: Row, column: DataTableColumn, runningMonth: number | null): DataTableCell {
  if (column.id === "label") return { text: row.label };
  const value = column.id === "total" ? row.total : row.cells[Number(column.id.slice(1))] ?? null;
  if (row.kind === "hit") {
    const heat = resolveHeatCellColors(value == null ? null : (value - 0.5) * 2);
    return { text: value == null ? "--" : `${Math.round(value * 100)}%`, value: value == null ? null : value * 100,
      backgroundColor: heat.background, color: heat.foreground };
  }
  const scale = column.id === "total" ? YEAR_SCALE : MONTH_SCALE;
  // The month still running is a return to date: shown, but not tinted as a finished month.
  const quiet = value == null || (row.partial && column.id === `m${runningMonth}`);
  const heat = resolveHeatCellColors(value == null ? null : value / scale, { quiet });
  return { text: pct(value), value: value == null ? null : value * 100, backgroundColor: heat.background, color: heat.foreground };
}

function overlaySeries(model: SeasonalityModel, colors: ReturnType<typeof useThemeColors>): ResolvedSeries[] {
  const toSeries = (id: string, label: string, color: string, points: { date: Date; value: number }[]): ResolvedSeries => ({
    ...staticSeries(points.map((point) => ({ date: point.date, observedAt: point.date, value: point.value * 100 })),
      { id, label, color, calendarSpaced: true }),
    unit: "%", unitGroup: "return",
  });
  const [latest, ...past] = model.paths;
  return [
    // Older years fade toward the background so the latest and the average stay on top.
    ...past.reverse().map((path, index) => toSeries(`y${path.year}`, String(path.year),
      blendHex(colors.bg, colors.textDim, 0.35 + 0.65 * ((index + 1) / past.length)), path.points)),
    ...(model.averagePath.length ? [toSeries("average", "Average", colors.warning, model.averagePath)] : []),
    ...(latest ? [toSeries(`y${latest.year}`, String(latest.year), colors.positive, latest.points)] : []),
  ];
}

export function SeasonalityPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const [view, setView] = usePluginPaneState("activeTabId", "returns");
  const [lookback, setLookback] = usePaneSettingValue("lookbackYears", "10");
  const [selectedRow, setSelectedRow] = usePluginPaneState<string | null>("selectedRow", null);
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const snapshot = await loadSeasonalityHistory({ instrument: instrument!, forceRefresh: force, signal: controller.current.signal });
    if (!snapshot.history.length && snapshot.error) throw new Error(snapshot.error);
    return snapshot;
  }, [instrumentKey]);
  const history = useAsyncResource(instrument ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => { void history.reload(); }, { focused });

  const model = useMemo(() => history.data ? projectSeasonality(history.data.history, { symbol: symbol ?? "", lookbackYears: Number(lookback) || 10 }) : null,
    [history.data, lookback, symbol]);
  const rows = useMemo(() => model ? tableRows(model) : [], [model]);
  const series = useMemo(() => model ? overlaySeries(model, colors) : [], [model, colors]);
  const runningMonth = model?.years[0]?.partial && model.asOf ? model.asOf.getUTCMonth() : null;

  usePaneNoticeFooter({ registrationId: "seasonality-notices", focused,
    notices: [...new Set([identityError, history.error, history.data?.error].filter((value): value is string => !!value))] });
  usePaneFooter("seasonality", () => ({ info: [
    ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
    ...(history.data?.stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    ...(model?.asOf ? [{ id: "date", parts: [{ text: `monthly closes to ${model.asOf.toISOString().slice(0, 7)}`, tone: "muted" as const }] }] : []),
  ] }), [history.loading, history.data?.stale, model?.asOf]);

  const stats = useMemo((): StatItem[] => {
    if (!model?.asOf || !model.years.length) return [];
    const month = model.asOf.getUTCMonth();
    const stat = model.months[month]!;
    const current = model.years[0]!;
    const tone = (value: number | null) => value == null ? undefined : value >= 0 ? "positive" as const : "negative" as const;
    return [
      { id: "month-avg", label: `${MONTH_LABELS[month]} avg`, value: pct(stat.mean), tone: tone(stat.mean) },
      { id: "month-hit", label: `${MONTH_LABELS[month]} up`, value: stat.count ? `${Math.round(stat.hitRate! * 100)}%` : "--",
        detail: stat.count ? `${Math.round(stat.hitRate! * stat.count)} of ${stat.count} yrs` : undefined },
      ...(current.partial ? [{ id: "ytd", label: `${current.year} YTD`, value: pct(current.total), tone: tone(current.total) }] : []),
    ];
  }, [model]);

  const { strip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: view, onSelect: setView, focused, dense: true });
  const contentHeight = Math.max(4, height - 1 - tabRows - statGridRows(stats, width));
  const palette = resolveChartPalette(colors);

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {strip}
    <QueryBar width={width} filters={[{ id: "lookback", label: "Lookback", value: String(lookback), options: LOOKBACK_OPTIONS, onChange: setLookback }]} />
    {!symbol ? <EmptyState title="Choose a ticker." /> : <PaneStatusBody subject="seasonality" loading={history.loading && !model}
      error={!model ? history.error ?? identityError ?? null : null} empty={!!model && !model.years.length}>
      {model ? <>
        <StatGrid items={stats} width={width} />
        {view === "overlay"
          ? <CompositeChart series={series} panels={[{ id: "main" }]} width={width} height={contentHeight} focused={focused}
            navigable={false} showLegend showTimeAxis remoteKind="seasonality"
            viewport={{ start: new Date(Date.UTC(OVERLAY_YEAR, 0, 1)), end: new Date(Date.UTC(OVERLAY_YEAR, 11, 31)) }} clipToViewport
            xAxis={{ ticks: MONTH_LABELS.map((label, month) => ({ ratio: (Date.UTC(OVERLAY_YEAR, month, 1) - Date.UTC(OVERLAY_YEAR, 0, 1)) / (365 * 86_400_000), label })),
              formatCursor: (ratio) => new Date(Date.UTC(OVERLAY_YEAR, 0, 1) + ratio * 365 * 86_400_000).toISOString().slice(5, 10) }}
            colors={{ background: palette.bgColor, grid: palette.gridColor, crosshair: palette.crosshairColor, text: colors.text,
              textDim: palette.axisColor, negative: colors.negative }} />
          : <DataTableView<Row> focused={focused} columns={COLUMNS} items={rows} rootWidth={width} rootHeight={contentHeight}
            getItemKey={(row) => row.id} emptyStateTitle="No monthly returns." sortColumnId={null} sortDirection="desc"
            selection={{ kind: "id", selectedId: selectedRow, getId: (row) => row.id, onChange: (id) => setSelectedRow(id) }}
            getExportMetadata={() => [["symbol", model.symbol], ["as of", model.asOf?.toISOString()], ["units", "percent, local-price close to close"]]}
            renderCell={(row, column) => renderCell(row, column, runningMonth)} />}
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
