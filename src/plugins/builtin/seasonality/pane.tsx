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
import { type DailyReturnStat, MONTH_LABELS, OVERLAY_YEAR, projectSeasonality, projectWeekdays, type SeasonalityModel,
  TURN_OF_MONTH_LABELS, WEEKDAY_LABELS, type WeekdayModel } from "./model";

const TABS = [{ value: "returns", label: "Returns" }, { value: "overlay", label: "Overlay" }, { value: "weekdays", label: "Weekdays" }];
export const LOOKBACK_OPTIONS = [{ value: "5", label: "5Y" }, { value: "10", label: "10Y" }, { value: "20", label: "20Y" }];
/** The move that tints a cell at full strength: a month of ±10%, a year of ±30%, an average session of ±0.5%. */
const MONTH_SCALE = 0.1, YEAR_SCALE = 0.3, SESSION_SCALE = 0.005;
function pct(value: number | null | undefined, digits = 1): string {
  if (value == null) return "--";
  const fixed = (value * 100).toFixed(digits);
  // A return that rounds to zero reads 0.0%, never -0.0%.
  return /[1-9]/.test(fixed) ? `${value > 0 ? "+" : ""}${fixed}%` : `${(0).toFixed(digits)}%`;
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

function hitCell(value: number | null): DataTableCell {
  const heat = resolveHeatCellColors(value == null ? null : (value - 0.5) * 2);
  return { text: value == null ? "--" : `${Math.round(value * 100)}%`, value: value == null ? null : value * 100,
    backgroundColor: heat.background, color: heat.foreground };
}

function renderCell(row: Row, column: DataTableColumn, runningMonth: number | null): DataTableCell {
  if (column.id === "label") return { text: row.label };
  const value = column.id === "total" ? row.total : row.cells[Number(column.id.slice(1))] ?? null;
  if (row.kind === "hit") return hitCell(value);
  const scale = column.id === "total" ? YEAR_SCALE : MONTH_SCALE;
  // The month still running is a return to date: shown, but not tinted as a finished month.
  const quiet = value == null || (row.partial && column.id === `m${runningMonth}`);
  const heat = resolveHeatCellColors(value == null ? null : value / scale, { quiet });
  return { text: pct(value), value: value == null ? null : value * 100, backgroundColor: heat.background, color: heat.foreground };
}

type WeekdayRow = { kind: "section"; id: string; label: string } | { kind: "stat"; id: string; label: string; stat: DailyReturnStat };

const WEEKDAY_COLUMNS: DataTableColumn[] = [
  { id: "label", label: "Day", width: 10, align: "left" },
  { id: "mean", label: "Avg", width: 9, align: "right" },
  { id: "median", label: "Median", width: 9, align: "right" },
  { id: "hitRate", label: "Up %", width: 7, align: "right" },
  { id: "count", label: "Sessions", width: 9, align: "right" },
];

function weekdayRows(model: WeekdayModel): WeekdayRow[] {
  const stat = (label: string, value: DailyReturnStat): WeekdayRow => ({ kind: "stat", id: label, label, stat: value });
  return [
    { kind: "section", id: "weekdays", label: "By weekday" },
    ...model.weekdays.map((value, day) => stat(WEEKDAY_LABELS[day]!, value)),
    { kind: "section", id: "turn", label: "Turn of month" },
    ...model.turnOfMonth.map((value, index) => stat(TURN_OF_MONTH_LABELS[index]!, value)),
  ];
}

function renderWeekdayCell(row: WeekdayRow, column: DataTableColumn): DataTableCell {
  if (row.kind === "section") return { text: "" };
  if (column.id === "label") return { text: row.label };
  if (column.id === "count") return { text: String(row.stat.count), value: row.stat.count };
  if (column.id === "hitRate") return hitCell(row.stat.hitRate);
  const value = column.id === "mean" ? row.stat.mean : row.stat.median;
  const heat = resolveHeatCellColors(value == null ? null : value / SESSION_SCALE);
  return { text: pct(value, 2), value: value == null ? null : value * 100, backgroundColor: heat.background, color: heat.foreground };
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

const tone = (value: number | null) => value == null ? undefined : value >= 0 ? "positive" as const : "negative" as const;

function weekdayStats(model: WeekdayModel): StatItem[] {
  const figure = (id: string, label: string, stat: DailyReturnStat): StatItem => ({ id, label, value: pct(stat.mean, 2), tone: tone(stat.mean),
    detail: stat.count ? `${Math.round(stat.hitRate! * 100)}% up, ${stat.count} sessions` : undefined });
  return [figure("turn", "Turn of month", model.turnWindow), figure("other", "Other days", model.otherDays)];
}

function monthStats(model: SeasonalityModel): StatItem[] {
  if (!model.asOf || !model.years.length) return [];
  const month = model.asOf.getUTCMonth();
  const stat = model.months[month]!;
  const current = model.years[0]!;
  return [
    { id: "month-avg", label: `${MONTH_LABELS[month]} avg`, value: pct(stat.mean), tone: tone(stat.mean) },
    { id: "month-hit", label: `${MONTH_LABELS[month]} up`, value: stat.count ? `${Math.round(stat.hitRate! * 100)}%` : "--",
      detail: stat.count ? `${Math.round(stat.hitRate! * stat.count)} of ${stat.count} yrs` : undefined },
    ...(current.partial ? [{ id: "ytd", label: `${current.year} YTD`, value: pct(current.total), tone: tone(current.total) }] : []),
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
  const exchange = instrument?.exchange;
  // Weekdays reads daily closes, the other tabs monthly ones; only the open tab's cadence is fetched.
  const cadence = view === "weekdays" ? "daily" : "monthly";
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const snapshot = await loadSeasonalityHistory({ instrument: instrument!, cadence, forceRefresh: force, signal: controller.current.signal });
    if (!snapshot.history.length && snapshot.error) throw new Error(snapshot.error);
    return snapshot;
  }, [instrumentKey, cadence]);
  const history = useAsyncResource(instrument ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => { void history.reload(); }, { focused });

  const lookbackYears = Number(lookback) || 10;
  const model = useMemo(() => history.data && cadence === "monthly"
    ? projectSeasonality(history.data.history, { symbol: symbol ?? "", lookbackYears }) : null, [history.data, cadence, lookbackYears, symbol]);
  const weekdayModel = useMemo(() => history.data && cadence === "daily"
    ? projectWeekdays(history.data.history, { symbol: symbol ?? "", exchange, lookbackYears }) : null,
  [history.data, cadence, lookbackYears, symbol, exchange]);
  const rows = useMemo(() => model ? tableRows(model) : [], [model]);
  const dailyRows = useMemo(() => weekdayModel ? weekdayRows(weekdayModel) : [], [weekdayModel]);
  const series = useMemo(() => model ? overlaySeries(model, colors) : [], [model, colors]);
  const runningMonth = model?.years[0]?.partial && model.asOf ? model.asOf.getUTCMonth() : null;

  usePaneNoticeFooter({ registrationId: "seasonality-notices", focused,
    notices: [...new Set([identityError, history.error, history.data?.error].filter((value): value is string => !!value))] });
  const closes = model?.asOf ? `monthly closes to ${model.asOf.toISOString().slice(0, 7)}`
    : weekdayModel?.start ? `daily closes ${weekdayModel.start} to ${weekdayModel.asOf}` : null;
  usePaneFooter("seasonality", () => ({ info: [
    ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
    ...(history.data?.stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    ...(closes ? [{ id: "date", parts: [{ text: closes, tone: "muted" as const }] }] : []),
  ] }), [history.loading, history.data?.stale, closes]);

  const stats = useMemo((): StatItem[] => weekdayModel?.start ? weekdayStats(weekdayModel) : model ? monthStats(model) : [],
    [model, weekdayModel]);

  const { strip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: view, onSelect: setView, focused, dense: true });
  const contentHeight = Math.max(4, height - 1 - tabRows - statGridRows(stats, width));
  const palette = resolveChartPalette(colors);

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {strip}
    <QueryBar width={width} filters={[{ id: "lookback", label: "Lookback", value: String(lookback), options: LOOKBACK_OPTIONS, onChange: setLookback }]} />
    {!symbol ? <EmptyState title="Choose a ticker." /> : <PaneStatusBody subject="seasonality" loading={history.loading && !model && !weekdayModel}
      error={!model && !weekdayModel ? history.error ?? identityError ?? null : null}
      empty={model ? !model.years.length : !!weekdayModel && !weekdayModel.start}>
      {weekdayModel ? <>
        <StatGrid items={stats} width={width} />
        <DataTableView<WeekdayRow> focused={focused} columns={WEEKDAY_COLUMNS} items={dailyRows} rootWidth={width} rootHeight={contentHeight}
          getItemKey={(row) => row.id} emptyStateTitle="No daily returns." sortColumnId={null} sortDirection="desc"
          isNavigable={(row) => row.kind === "stat"} renderSectionHeader={(row) => row.kind === "section" ? { text: row.label } : null}
          selection={{ kind: "id", selectedId: selectedRow, getId: (row) => row.id, onChange: (id) => setSelectedRow(id) }}
          getExportMetadata={() => [["symbol", weekdayModel.symbol], ["from", weekdayModel.start], ["as of", weekdayModel.asOf],
            ["units", "percent, local-price session close to close"]]}
          renderCell={renderWeekdayCell} />
      </> : model ? <>
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
