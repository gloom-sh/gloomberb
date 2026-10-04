import { useCallback, useEffect, useMemo, useRef } from "react";
import { DataTableView, EmptyState, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneFooter, usePaneNoticeFooter,
  usePaneTicker, type DataTableCell, type DataTableColumn, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { loadMacroDayHistory } from "./client";
import { projectMacroDays, type MacroDayEvent, type MacroDayModel } from "./model";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, type MacroEventKind } from "./releases";

export const LOOKBACK_OPTIONS = [{ value: "1", label: "1Y" }, { value: "2", label: "2Y" }, { value: "3", label: "3Y" }, { value: "5", label: "5Y" }];
const RELEASE_OPTIONS = [{ value: "all", label: "All" }, ...MACRO_EVENT_KINDS.map((kind) => ({ value: kind, label: MACRO_EVENT_LABELS[kind] }))];

function pct(value: number | null | undefined, signed = true): string {
  if (value == null) return "--";
  const fixed = (value * 100).toFixed(2);
  return /[1-9]/.test(fixed) ? `${signed && value > 0 ? "+" : ""}${fixed}%` : "0.00%";
}
const times = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(1)}x`;

const COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Date", width: 19, align: "left" },
  { id: "release", label: "Release", width: 8, align: "left" },
  { id: "move", label: "Move", width: 9, align: "right" },
  { id: "multiple", label: "vs Normal", width: 10, align: "right" },
];
/** One release selected: every row would repeat its name. */
const ONE_RELEASE_COLUMNS = COLUMNS.filter((column) => column.id !== "release");

function figures(model: MacroDayModel, release: string): StatItem[] {
  const normal: StatItem = { id: "normal", label: "Normal day", value: pct(model.normal.meanAbs, false), detail: "avg |move|" };
  if (release === "all") {
    return [...MACRO_EVENT_KINDS.map((kind): StatItem => {
      const stats = model.byKind[kind];
      return { id: kind, label: `${MACRO_EVENT_LABELS[kind]} day`, value: pct(stats.meanAbs, false),
        detail: stats.count ? `${times(stats.multiple)} normal` : undefined };
    }), normal];
  }
  const stats = model.byKind[release as MacroEventKind];
  const tone = (value: number | null) => value == null ? undefined : value >= 0 ? "positive" as const : "negative" as const;
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
  const [selectedRow, setSelectedRow] = usePluginPaneState<string | null>("selectedRow", null);
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const snapshot = await loadMacroDayHistory({ instrument: instrument!, forceRefresh: force, signal: controller.current.signal });
    if (!snapshot.history.length && snapshot.error) throw new Error(snapshot.error);
    return snapshot;
  }, [instrumentKey]);
  const history = useAsyncResource(instrument ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => { void history.reload(); }, { focused });

  const model = useMemo(() => history.data ? projectMacroDays(history.data.history, { symbol: symbol ?? "", lookbackYears: Number(lookback) || 5 }) : null,
    [history.data, lookback, symbol]);
  const rows = useMemo(() => model ? model.events.filter((event) => release === "all" || event.kind === release) : [], [model, release]);
  const stats = useMemo(() => model?.events.length ? figures(model, release) : [], [model, release]);

  usePaneNoticeFooter({ registrationId: "macro-day-notices", focused,
    notices: [...new Set([identityError, history.error, history.data?.error].filter((value): value is string => !!value))] });
  usePaneFooter("macro-day", () => ({ info: [
    ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
    ...(history.data?.stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    ...(model?.asOf ? [{ id: "date", parts: [{ text: `daily closes ${model.start} to ${model.asOf}`, tone: "muted" as const }] }] : []),
  ] }), [history.loading, history.data?.stale, model?.start, model?.asOf]);

  const renderCell = useCallback((event: MacroDayEvent, column: DataTableColumn): DataTableCell => {
    if (column.id === "date") return { text: event.session === event.date ? event.date : `${event.date} → ${event.session.slice(5)}`, value: event.date };
    if (column.id === "release") return { text: MACRO_EVENT_LABELS[event.kind] };
    if (column.id === "move") return { text: pct(event.move), value: event.move * 100,
      color: event.move > 0 ? colors.positive : event.move < 0 ? colors.negative : undefined };
    return { text: times(event.multiple), value: event.multiple };
  }, [colors]);

  const contentHeight = Math.max(4, height - 1 - statGridRows(stats, width));
  const key = (event: MacroDayEvent) => `${event.kind}:${event.date}`;

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} filters={[
      { id: "release", label: "Release", value: release, options: RELEASE_OPTIONS, onChange: setRelease, inline: true },
      { id: "lookback", label: "Lookback", value: String(lookback), options: LOOKBACK_OPTIONS, onChange: setLookback },
    ]} />
    {!symbol ? <EmptyState title="Choose a ticker." /> : <PaneStatusBody subject="macro-day moves" loading={history.loading && !model}
      error={!model ? history.error ?? identityError ?? null : null} empty={!!model && !model.events.length}>
      {model ? <>
        <StatGrid items={stats} width={width} />
        <DataTableView<MacroDayEvent> focused={focused} columns={release === "all" ? COLUMNS : ONE_RELEASE_COLUMNS} items={rows} rootWidth={width} rootHeight={contentHeight}
          getItemKey={key} emptyStateTitle="No release days." sortColumnId={null} sortDirection="desc" selectedTextOverridesCellColor
          selection={{ kind: "id", selectedId: selectedRow, getId: key, onChange: (id) => setSelectedRow(id) }}
          getExportMetadata={() => [["symbol", model.symbol], ["from", model.start ?? ""], ["to", model.asOf ?? ""],
            ["units", "percent, close to close on the release day"]]}
          renderCell={renderCell} />
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
