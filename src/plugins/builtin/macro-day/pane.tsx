import { dayCell, formatDay } from "../../../components/ui/day-cell";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { DataTableView, EmptyState, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneFooter, usePaneNoticeFooter,
  usePaneTicker, type DataTableCell, type DataTableColumn, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { tableColumnWidth } from "../../../components/ui/table-layout";
import { MISSING_VALUE, displayWidth } from "../../../utils/format";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { usePaneInstance } from "../../../state/app/context";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { shownPriceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { loadMacroDayEarnings, loadMacroDayHistory, loadMacroReleases, macroDayEarningsNotice } from "./client";
import { compareMacroDays, loadMacroDayTarget, MACRO_DAY_DAILY_BASIS, macroDayComparisonHeader, macroDayKey,
  projectMacroDayTargets, type MacroDayComparisonRow } from "./comparison";
import {
  formatMacroDayMove, macroDayEventLabel, macroDayEventNote, macroDayMoveDecimals, macroDayStats, matchesSurprise, macroFigureGapNotices,
  macroSurpriseBasisLabel, macroSurpriseExclusionNote, macroSurpriseOf, projectMacroDays, type MacroDayEvent,
  type MacroDayModel, type MacroDayMoveBasis,
} from "./model";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, MACRO_SURPRISE_LABELS, MACRO_SURPRISES, staleMacroReleasesNotice, type MacroEventKind,
  type MacroSurprise } from "./releases";

export const LOOKBACK_OPTIONS = [{ value: "1", label: "1Y" }, { value: "2", label: "2Y" }, { value: "3", label: "3Y" }, { value: "5", label: "5Y" }];
const RELEASE_OPTIONS = [{ value: "all", label: "All" }, ...MACRO_EVENT_KINDS.map((kind) => ({ value: kind, label: MACRO_EVENT_LABELS[kind] }))];
const SURPRISE_OPTIONS = [{ value: "all", label: "All" }, ...MACRO_SURPRISES.map((surprise) => ({ value: surprise, label: MACRO_SURPRISE_LABELS[surprise] }))];

const times = (value: number | null | undefined) => value == null ? MISSING_VALUE : `${value.toFixed(1)}x`;

const DATE: DataTableColumn = { id: "date", label: "Date", width: 20, align: "left" };
/** The move and its multiple of a normal day's; a yield's move is in basis points, and its header says so. */
const moveColumns = (basis: MacroDayMoveBasis): DataTableColumn[] => [
  { id: "move", label: basis === "yield" ? "Move bp" : "Move", width: 9, align: "right" },
  { id: "multiple", label: "vs Normal", width: 10, align: "right" },
];
/**
 * What a narrow desktop pane gives up first: the figures the economic calendar
 * also holds, from the prior print to the actual. The day, its release and the
 * move are what the pane is for.
 */
const COLUMN_DROP_ORDER = ["prior", "forecast", "surprise", "actual"] as const;
/** What each release came out with, under the labels the economic calendar gives them. */
const FIGURES = [["actual", "Actual"], ["forecast", "Forecast"], ["prior", "Prior"]] as const;

/**
 * Whether the print came in hot, cool or in line, in words, so it never rests on the Actual's colour alone; a
 * surprise read from another print than the headline's names it: "Hot (core m/m)".
 */
export function macroSurpriseText(event: Pick<MacroDayEvent, "figures">): string {
  const surprise = macroSurpriseOf(event.figures);
  if (!surprise) return "";
  const basis = macroSurpriseBasisLabel(event.figures);
  return basis ? `${MACRO_SURPRISE_LABELS[surprise]} (${basis})` : MACRO_SURPRISE_LABELS[surprise];
}

/** The figure columns, shown once any listed day has figures, each as wide as its header and its widest value; Surprise after them. */
function figureColumns(rows: readonly MacroDayEvent[]): DataTableColumn[] {
  if (!rows.some((event) => event.figures)) return [];
  return [...FIGURES.map(([id, label]): DataTableColumn => ({ id, label, align: "right", width: tableColumnWidth({ label,
    width: Math.max(6, ...rows.map((event) => displayWidth(event.figures?.[id] ?? ""))) }) })),
  { id: "surprise", label: "Surprise", align: "left", width: tableColumnWidth({ label: "Surprise",
    width: Math.max(...rows.map((event) => displayWidth(macroSurpriseText(event)))) }) }];
}

/**
 * With every release listed, the release's name, widened to take a policy decision and the earnings marker where a row
 * has them. With one selected, a column only for those: every row would repeat the name.
 */
export function columnsFor(release: string, rows: readonly MacroDayEvent[], basis: MacroDayMoveBasis = "return"): DataTableColumn[] {
  const values = [...figureColumns(rows), ...moveColumns(basis)];
  if (release === "all") return [DATE, { id: "release", label: "Release", align: "left",
    width: tableColumnWidth({ label: "Release", width: Math.max(6, ...rows.map((event) => displayWidth(macroDayEventLabel(event)))) }) }, ...values];
  const notes = rows.map((event) => displayWidth(macroDayEventNote(event)));
  return notes.some(Boolean) ? [DATE, { id: "release", label: "Note", align: "left", width: tableColumnWidth({ label: "Note", width: Math.max(...notes) }) },
    ...values] : [DATE, ...values];
}

/** By the sign the text shows: an average that rounds to 0.00% (or 0.0bp) is neither up nor down. */
export const moveTone = (value: number | null, basis: MacroDayMoveBasis = "return") =>
  value == null || !/[1-9]/.test((value * 100).toFixed(macroDayMoveDecimals(basis))) ? undefined
    : value > 0 ? "positive" as const : "negative" as const;

/** The figures over the days a surprise filter keeps: the same four as one release's. */
function surpriseFigures(model: MacroDayModel, rows: readonly MacroDayEvent[]): StatItem[] {
  const stats = macroDayStats(rows, model.normal.meanAbs);
  const pct = (value: number | null, signed = true) => formatMacroDayMove(value, model.basis, { signed });
  return [
    { id: "abs", label: "Avg |move|", value: pct(stats.meanAbs, false), detail: stats.count ? `${times(stats.multiple)} normal` : undefined },
    { id: "mean", label: "Avg move", value: pct(stats.mean), tone: moveTone(stats.mean, model.basis) },
    { id: "up", label: "Up", value: stats.hitRate == null ? MISSING_VALUE : `${Math.round(stats.hitRate * 100)}%`,
      detail: stats.count ? `${Math.round(stats.hitRate! * stats.count)} of ${stats.count}` : undefined },
    { id: "normal", label: "Normal day", value: pct(model.normal.meanAbs, false), detail: "avg |move|" },
  ];
}

function figures(model: MacroDayModel, release: string): StatItem[] {
  const pct = (value: number | null, signed = true) => formatMacroDayMove(value, model.basis, { signed });
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
    { id: "mean", label: "Avg move", value: pct(stats.mean), tone: moveTone(stats.mean, model.basis) },
    { id: "up", label: "Up", value: stats.hitRate == null ? MISSING_VALUE : `${Math.round(stats.hitRate * 100)}%`,
      detail: stats.count ? `${Math.round(stats.hitRate! * stats.count)} of ${stats.count}` : undefined },
    normal,
  ];
}

function useMacroDayFilters() {
  const [lookback, setLookback] = usePaneSettingValue("lookbackYears", "5");
  const [release, setRelease] = usePluginPaneState("release", "all");
  const [surprise, setSurprise] = usePluginPaneState<MacroSurprise | "all">("surprise", "all");
  return { lookback, setLookback, release, setRelease, surprise, setSurprise };
}

function MacroDayQuery({ width, filters }: { width: number; filters: ReturnType<typeof useMacroDayFilters> }) {
  const { release, setRelease, surprise, setSurprise, lookback, setLookback } = filters;
  return <QueryBar width={width} filters={[
    { id: "release", label: "Release", value: release, options: RELEASE_OPTIONS, onChange: setRelease, inline: true },
    { id: "surprise", label: "Surprise", value: surprise, options: SURPRISE_OPTIONS, onChange: (value) => setSurprise(value as MacroSurprise | "all") },
    { id: "lookback", label: "Lookback", value: String(lookback), options: LOOKBACK_OPTIONS, onChange: setLookback },
  ]} />;
}

export function MacroDayPane(props: PaneProps) {
  const symbols = usePaneInstance()?.params?.symbols;
  return symbols ? <MacroDayComparisonPane key={symbols} {...props} list={symbols} /> : <SingleMacroDayPane {...props} />;
}

function MacroDayComparisonPane({ width, height, focused, list }: PaneProps & { list: string }) {
  const colors = useThemeColors();
  const filters = useMacroDayFilters();
  const { lookback, release, surprise } = filters;
  const [selectedRow, setSelectedRow] = usePluginPaneState<string | null>("selectedRow", null);
  const scope = useCloudDisplayScope();
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (forceRefresh: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const { signal } = controller.current;
    const [releases, targets] = await Promise.all([loadMacroReleases({ force: forceRefresh }), Promise.all(list.split(",").map((symbol) =>
      loadMacroDayTarget(symbol, () => parsePublicTickerKey(symbol), { signal, forceRefresh })))]);
    if (targets.every((target) => !target.history.length && target.error)) throw new Error(targets[0]!.error!);
    return { releases, targets };
  }, [list]);
  const history = useAsyncResource(scope ? loader : null, { savedCopy: scope ? { key: ["macro-day-compare", scope, list] } : null,
    shouldSave: (answer) => answer.targets.every((target) => !target.stale && !target.error) });
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => history.reload(), { focused });

  const models = useMemo(() => history.data ? projectMacroDayTargets(history.data.targets, history.data.releases, Number(lookback) || 5) : [], [history.data, lookback]);
  const scoped = useMemo(() => compareMacroDays(models).filter((event) => release === "all" || event.kind === release), [models, release]);
  const rows = useMemo(() => scoped.filter((event) => matchesSurprise(event, surprise)), [scoped, surprise]);
  const columns = useMemo<DataTableColumn[]>(() => [
    { ...DATE, width: 11 }, { id: "release", label: "Release", width: 12, align: "left" },
    ...models.map((model) => ({ id: model.symbol, label: macroDayComparisonHeader(model),
      width: Math.max(8, displayWidth(macroDayComparisonHeader(model))), align: "right" as const })),
    ...figureColumns(rows),
  ], [models, rows]);
  const hasEarnings = rows.some((day) => [...day.moves.values()].some((move) => move.earnings));
  const usesNextSession = rows.some((day) => [...day.moves.values()].some((move) => move.session !== day.date));
  usePaneNoticeFooter({ registrationId: "macro-day-comparison-notices", focused, notices: [
    ...(usesNextSession ? ["Where the market was shut, the move uses the next available session."] : []),
    ...(hasEarnings ? ["* Also an earnings reaction session for this instrument."] : []),
    ...[history.data && staleMacroReleasesNotice(history.data.releases), macroSurpriseExclusionNote(scoped, surprise)]
      .filter((note): note is string => !!note),
    ...(history.data?.targets.flatMap(({ symbol, error, earningsNotice }) => [error, earningsNotice]
      .flatMap((notice) => notice ? [`${symbol}: ${notice}`] : [])) ?? []),
    ...macroFigureGapNotices(rows),
  ] });
  const stale = history.data?.targets.some((target) => target.stale);
  usePaneFooter("macro-day-comparison", () => ({ info: [
    ...(stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    { id: "basis", parts: [{ text: "daily close-to-close", tone: "muted" as const }] },
  ] }), [stale]);
  const renderCell = (event: MacroDayComparisonRow, column: DataTableColumn): DataTableCell => {
    if (column.id === "date") return dayCell(event.date);
    if (column.id === "release") return { text: macroDayEventLabel(event) };
    if (column.id === "actual" || column.id === "forecast" || column.id === "prior") return { text: event.figures?.[column.id] ?? "" };
    if (column.id === "surprise") return { text: macroSurpriseText(event) };
    const move = event.moves.get(column.id);
    const basis = models.find((model) => model.symbol === column.id)?.basis ?? "return";
    return move ? { text: `${formatMacroDayMove(move.move, basis, { unit: false })}${move.earnings ? "*" : ""}`, value: move.move * 100,
      color: shownPriceColor(move.move * 100, macroDayMoveDecimals(basis), colors) } : { text: MISSING_VALUE };
  };
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <MacroDayQuery width={width} filters={filters} />
    <PaneStatusBody subject="macro-day moves" loading={history.loading && !history.data} error={!history.data ? history.error : null}>
      {history.data ? <DataTableView<MacroDayComparisonRow> focused={focused} columns={columns} items={rows} rootWidth={width} rootHeight={height - 1}
        getItemKey={macroDayKey} emptyStateTitle="No matching release days." sortColumnId={null} sortDirection="desc" selectedTextOverridesCellColor
        selection={{ kind: "id", selectedId: selectedRow, getId: macroDayKey, onChange: setSelectedRow }}
        getExportMetadata={() => [["basis", MACRO_DAY_DAILY_BASIS], ["units", models.map(macroDayComparisonHeader).join(", ")]]}
        renderCell={renderCell} /> : null}
    </PaneStatusBody>
  </Box>;
}

function SingleMacroDayPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const filters = useMacroDayFilters();
  const { lookback, release, surprise } = filters;
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
  const scope = useCloudDisplayScope();
  const history = useAsyncResource(scope && instrument ? loader : null, {
    savedCopy: scope && !instrument?.instrument ? { key: ["macro-day", scope, instrumentKey] } : null,
  });
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => { history.reload(); }, { focused });

  const model = useMemo(() => history.data ? projectMacroDays(history.data.history, { symbol: symbol ?? "", lookbackYears: Number(lookback) || 5,
    releases: history.data.releases.releases, coveredThrough: history.data.releases.coveredThrough, earnings: history.data.earnings.reports }) : null,
  [history.data, lookback, symbol]);
  const releasesNotice = history.data ? staleMacroReleasesNotice(history.data.releases) : null;
  const earningsNotice = history.data ? macroDayEarningsNotice(history.data.earnings) : null;
  const scoped = useMemo(() => model ? model.events.filter((event) => release === "all" || event.kind === release) : [], [model, release]);
  const rows = useMemo(() => scoped.filter((event) => matchesSurprise(event, surprise)), [scoped, surprise]);
  // A surprise filter says how many days in scope it could not read: "3 prints excluded: no actual."
  const excluded = useMemo(() => macroSurpriseExclusionNote(scoped, surprise), [scoped, surprise]);
  const stats = useMemo(() => !model?.events.length ? [] : surprise === "all" ? figures(model, release) : surpriseFigures(model, rows),
    [model, release, surprise, rows]);
  const columns = useMemo(() => columnsFor(release, rows, model?.basis), [model?.basis, release, rows]);

  // A covered release day the calendar left without figures says why; days before the calendar are the docs' to explain.
  // Why a listed day, or one the filter left out, has no actual.
  const figureGaps = useMemo(() => macroFigureGapNotices(surprise === "all" ? rows : scoped.filter((event) => matchesSurprise(event, surprise)
    || macroSurpriseOf(event.figures) == null)), [rows, scoped, surprise]);
  usePaneNoticeFooter({ registrationId: "macro-day-notices", focused,
    notices: [...new Set([identityError, history.error, history.data?.error, releasesNotice, earningsNotice, excluded, ...figureGaps]
      .filter((value): value is string => !!value))] });
  usePaneFooter("macro-day", () => ({ info: [
    ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
    ...(history.data?.stale || history.data?.earnings.stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    ...(model?.asOf ? [{ id: "date", parts: [{ text: `daily closes ${model.start} to ${model.asOf}`, tone: "muted" as const }] }] : []),
  ] }), [history.loading, history.data?.stale, history.data?.earnings.stale, model?.start, model?.asOf]);

  const renderCell = useCallback((event: MacroDayEvent, column: DataTableColumn): DataTableCell => {
    if (column.id === "date") return { text: event.session === event.date ? formatDay(event.date) : `${formatDay(event.date)} → ${formatDay(event.session, "no-year")}`, value: event.date };
    if (column.id === "release") return { text: release === "all" ? macroDayEventLabel(event) : macroDayEventNote(event) };
    // The print colored against the consensus, as the economic calendar colors it.
    if (column.id === "actual") return { text: event.figures?.actual ?? "", color: event.figures?.surprise === "hot" ? colors.positive
      : event.figures?.surprise === "cool" ? colors.negative : undefined };
    if (column.id === "forecast") return { text: event.figures?.forecast ?? "" };
    if (column.id === "surprise") return { text: macroSurpriseText(event) };
    if (column.id === "prior") return { text: event.figures?.prior ?? "" };
    if (column.id === "move") {
      const basis = model?.basis ?? "return";
      // Under a column headed bp, a yield's move is the number alone.
      return { text: formatMacroDayMove(event.move, basis, { unit: false }), value: event.move * 100,
        color: shownPriceColor(event.move * 100, macroDayMoveDecimals(basis), colors) };
    }
    return { text: times(event.multiple), value: event.multiple };
  }, [colors, model?.basis, release]);

  // A figure wraps only into rows the table's least leaves, so the pane never spills.
  const statMaxLines = height - 1 - 4;
  const contentHeight = Math.max(4, height - 1 - statGridRows(stats, width, undefined, { maxLines: statMaxLines }));
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <MacroDayQuery width={width} filters={filters} />
    {!symbol ? <EmptyState title="Select a ticker." /> : <PaneStatusBody subject="macro-day moves" loading={history.loading && !model}
      error={!model ? history.error ?? identityError ?? null : null} empty={!!model && !model.events.length}>
      {model ? <>
        <StatGrid items={stats} width={width} maxLines={statMaxLines} />
        <DataTableView<MacroDayEvent> focused={focused} columns={columns} columnDropOrder={COLUMN_DROP_ORDER} items={rows} rootWidth={width} rootHeight={contentHeight}
          getItemKey={macroDayKey} emptyStateTitle={surprise === "all" ? "No release days." : `No ${MACRO_SURPRISE_LABELS[surprise].toLowerCase()} prints.`} sortColumnId={null} sortDirection="desc" selectedTextOverridesCellColor
          selection={{ kind: "id", selectedId: selectedRow, getId: macroDayKey, onChange: setSelectedRow }}
          getExportMetadata={() => [["symbol", model.symbol], ["from", model.start ?? ""], ["to", model.asOf ?? ""],
            ["units", model.basis === "yield" ? "percentage points of yield, close to close on the release day"
              : "percent, close to close on the release day"]]}
          renderCell={renderCell} />
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
