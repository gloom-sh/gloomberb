import { useCallback, useEffect, useMemo, useRef } from "react";
import { DataTableView, EmptyState, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneFooter, usePaneNoticeFooter,
  usePaneTicker, type DataTableCell, type DataTableColumn, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { tableColumnWidth } from "../../../components/ui/table-layout";
import { displayWidth } from "../../../utils/format";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { loadMacroDayEarnings, loadMacroDayHistory, loadMacroReleases, macroDayEarningsNotice } from "./client";
import { macroDayEventLabel, macroDayStats, matchesSurprise, projectMacroDays, type MacroDayEvent, type MacroDayModel } from "./model";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, MACRO_SURPRISE_LABELS, MACRO_SURPRISES, staleMacroReleasesNotice, type MacroEventKind,
  type MacroSurprise } from "./releases";

export const LOOKBACK_OPTIONS = [{ value: "1", label: "1Y" }, { value: "2", label: "2Y" }, { value: "3", label: "3Y" }, { value: "5", label: "5Y" }];
const RELEASE_OPTIONS = [{ value: "all", label: "All" }, ...MACRO_EVENT_KINDS.map((kind) => ({ value: kind, label: MACRO_EVENT_LABELS[kind] }))];
const SURPRISE_OPTIONS = [{ value: "all", label: "All" }, ...MACRO_SURPRISES.map((surprise) => ({ value: surprise, label: MACRO_SURPRISE_LABELS[surprise] }))];

function pct(value: number | null | undefined, signed = true): string {
  if (value == null) return "--";
  const fixed = (value * 100).toFixed(2);
  return /[1-9]/.test(fixed) ? `${signed && value > 0 ? "+" : ""}${fixed}%` : "0.00%";
}
const times = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(1)}x`;

const EARNINGS_MARK = "earnings";
const DATE: DataTableColumn = { id: "date", label: "Date", width: 19, align: "left" };
const MOVE: DataTableColumn[] = [
  { id: "move", label: "Move", width: 9, align: "right" },
  { id: "multiple", label: "vs Normal", width: 10, align: "right" },
];
/** What each release came out with, under the labels the economic calendar gives them. */
const FIGURES = [["actual", "Actual"], ["forecast", "Forecast"], ["prior", "Prior"]] as const;

/** The figure columns, shown once any listed day has figures, each as wide as its header and its widest value. */
function figureColumns(rows: readonly MacroDayEvent[]): DataTableColumn[] {
  if (!rows.some((event) => event.figures)) return [];
  return FIGURES.map(([id, label]) => ({ id, label, align: "right", width: tableColumnWidth({ label,
    width: Math.max(6, ...rows.map((event) => displayWidth(event.figures?.[id] ?? ""))) }) }));
}

/**
 * With every release listed, the release's name, widened to take the earnings marker where a row has one. With one
 * selected, a column only for the marker: every row would repeat the name.
 */
export function columnsFor(release: string, rows: readonly MacroDayEvent[]): DataTableColumn[] {
  const marked = rows.some((event) => event.earnings);
  const values = [...figureColumns(rows), ...MOVE];
  if (release === "all") return [DATE, { id: "release", label: "Release", width: marked ? 15 : 8, align: "left" }, ...values];
  return marked ? [DATE, { id: "release", label: "Note", width: EARNINGS_MARK.length, align: "left" }, ...values] : [DATE, ...values];
}

const tone = (value: number | null) => value == null ? undefined : value >= 0 ? "positive" as const : "negative" as const;

/** The figures over the days a surprise filter keeps: the same four as one release's. */
function surpriseFigures(model: MacroDayModel, rows: readonly MacroDayEvent[]): StatItem[] {
  const stats = macroDayStats(rows, model.normal.meanAbs);
  return [
    { id: "abs", label: "Avg |move|", value: pct(stats.meanAbs, false), detail: stats.count ? `${times(stats.multiple)} normal` : undefined },
    { id: "mean", label: "Avg move", value: pct(stats.mean), tone: tone(stats.mean) },
    { id: "up", label: "Up", value: stats.hitRate == null ? "--" : `${Math.round(stats.hitRate * 100)}%`,
      detail: stats.count ? `${Math.round(stats.hitRate! * stats.count)} of ${stats.count}` : undefined },
    { id: "normal", label: "Normal day", value: pct(model.normal.meanAbs, false), detail: "avg |move|" },
  ];
}

function figures(model: MacroDayModel, release: string): StatItem[] {
  const normal: StatItem = { id: "normal", label: "Normal day", value: pct(model.normal.meanAbs, false), detail: "avg |move|" };
  if (release === "all") {
    return [...model.kinds.map((kind): StatItem => {
      const stats = model.byKind[kind];
      return { id: kind, label: `${MACRO_EVENT_LABELS[kind]} day`, value: pct(stats.meanAbs, false),
        detail: stats.count ? `${times(stats.multiple)} normal` : undefined };
    }), ...(model.earnings.count ? [{ id: "earnings", label: "Earnings day", value: pct(model.earnings.meanAbs, false),
      detail: `${times(model.earnings.multiple)} normal` }] : []), normal];
  }
  const stats = model.byKind[release as MacroEventKind];
  return [
    { id: "abs", label: "Avg |move|", value: pct(stats.meanAbs, false), detail: stats.count ? `${times(stats.multiple)} normal` : undefined },
    { id: "mean", label: "Avg move", value: pct(stats.mean), tone: tone(stats.mean) },
    { id: "up", label: "Up", value: stats.hitRate == null ? "--" : `${Math.round(stats.hitRate * 100)}%`,
      detail: stats.count ? `${Math.round(stats.hitRate! * stats.count)} of ${stats.count}` : undefined },
    normal,
  ];
}

export function MacroDayPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const [lookback, setLookback] = usePaneSettingValue("lookbackYears", "5");
  const [release, setRelease] = usePluginPaneState("release", "all");
  const [surprise, setSurprise] = usePluginPaneState<MacroSurprise | "all">("surprise", "all");
  const [selectedRow, setSelectedRow] = usePluginPaneState<string | null>("selectedRow", null);
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const request = { instrument: instrument!, forceRefresh: force, signal: controller.current.signal };
    const [snapshot, releases, earnings] = await Promise.all([loadMacroDayHistory(request), loadMacroReleases({ force }), loadMacroDayEarnings(request)]);
    if (!snapshot.history.length && snapshot.error) throw new Error(snapshot.error);
    return { ...snapshot, releases, earnings };
  }, [instrumentKey]);
  const history = useAsyncResource(instrument ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => { void history.reload(); }, { focused });

  const model = useMemo(() => history.data ? projectMacroDays(history.data.history, { symbol: symbol ?? "", lookbackYears: Number(lookback) || 5,
    releases: history.data.releases.releases, coveredThrough: history.data.releases.coveredThrough, earnings: history.data.earnings.reports }) : null,
  [history.data, lookback, symbol]);
  const releasesNotice = history.data ? staleMacroReleasesNotice(history.data.releases) : null;
  const earningsNotice = history.data ? macroDayEarningsNotice(history.data.earnings) : null;
  const rows = useMemo(() => model ? model.events.filter((event) => (release === "all" || event.kind === release)
    && matchesSurprise(event, surprise)) : [], [model, release, surprise]);
  const stats = useMemo(() => !model?.events.length ? [] : surprise === "all" ? figures(model, release) : surpriseFigures(model, rows),
    [model, release, surprise, rows]);
  const columns = useMemo(() => columnsFor(release, rows), [release, rows]);

  usePaneNoticeFooter({ registrationId: "macro-day-notices", focused,
    notices: [...new Set([identityError, history.error, history.data?.error, releasesNotice, earningsNotice].filter((value): value is string => !!value))] });
  usePaneFooter("macro-day", () => ({ info: [
    ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
    ...(history.data?.stale || history.data?.earnings.stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    ...(model?.asOf ? [{ id: "date", parts: [{ text: `daily closes ${model.start} to ${model.asOf}`, tone: "muted" as const }] }] : []),
  ] }), [history.loading, history.data?.stale, history.data?.earnings.stale, model?.start, model?.asOf]);

  const renderCell = useCallback((event: MacroDayEvent, column: DataTableColumn): DataTableCell => {
    if (column.id === "date") return { text: event.session === event.date ? event.date : `${event.date} → ${event.session.slice(5)}`, value: event.date };
    if (column.id === "release") return { text: release === "all" ? macroDayEventLabel(event) : event.earnings ? EARNINGS_MARK : "" };
    // The print colored against the consensus, as the economic calendar colors it.
    if (column.id === "actual") return { text: event.figures?.actual ?? "", color: event.figures?.surprise === "hot" ? colors.positive
      : event.figures?.surprise === "cool" ? colors.negative : undefined };
    if (column.id === "forecast") return { text: event.figures?.forecast ?? "" };
    if (column.id === "prior") return { text: event.figures?.prior ?? "" };
    if (column.id === "move") return { text: pct(event.move), value: event.move * 100,
      color: event.move > 0 ? colors.positive : event.move < 0 ? colors.negative : undefined };
    return { text: times(event.multiple), value: event.multiple };
  }, [colors, release]);

  const contentHeight = Math.max(4, height - 1 - statGridRows(stats, width));
  const key = (event: MacroDayEvent) => `${event.kind}:${event.date}`;

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} filters={[
      { id: "release", label: "Release", value: release, options: RELEASE_OPTIONS, onChange: setRelease, inline: true },
      { id: "surprise", label: "Surprise", value: surprise, options: SURPRISE_OPTIONS, onChange: (value) => setSurprise(value as MacroSurprise | "all") },
      { id: "lookback", label: "Lookback", value: String(lookback), options: LOOKBACK_OPTIONS, onChange: setLookback },
    ]} />
    {!symbol ? <EmptyState title="Select a ticker." /> : <PaneStatusBody subject="macro-day moves" loading={history.loading && !model}
      error={!model ? history.error ?? identityError ?? null : null} empty={!!model && !model.events.length}>
      {model ? <>
        <StatGrid items={stats} width={width} />
        <DataTableView<MacroDayEvent> focused={focused} columns={columns} items={rows} rootWidth={width} rootHeight={contentHeight}
          getItemKey={key} emptyStateTitle={surprise === "all" ? "No release days." : `No ${MACRO_SURPRISE_LABELS[surprise].toLowerCase()} prints.`} sortColumnId={null} sortDirection="desc" selectedTextOverridesCellColor
          selection={{ kind: "id", selectedId: selectedRow, getId: key, onChange: (id) => setSelectedRow(id) }}
          getExportMetadata={() => [["symbol", model.symbol], ["from", model.start ?? ""], ["to", model.asOf ?? ""],
            ["units", "percent, close to close on the release day"]]}
          renderCell={renderCell} />
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
