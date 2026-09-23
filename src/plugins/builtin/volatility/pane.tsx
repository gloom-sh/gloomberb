import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, PaneStatusBody, StatGrid, statGridRows, Tabs, usePaneFooter, usePaneHeaderTabs, usePaneNoticeFooter,
  type DataTableColumn, type DataTableKeyEvent, type StatItem } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text } from "../../../ui";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { useLiveSessionRefresh, useThrottledValue } from "../shared/volatility/live-session";
import { getCachedVolatilityData, loadVolatilityData, type VolatilityLoadResult } from "./client";
import { boardOrder, buildVolatilityData, IMPLIED_CORRELATION_ROWS, VOLATILITY_CURVE_INDICES, VOLATILITY_INDICES, withLiveVolatilityLevels, type VolatilityBoardRow, type VolatilityIndexId, type VolatilityLiveLevel } from "./model";
import { VolatilityCurveChart, VolatilityHistoryChart, VolatilityIndexHistoryChart } from "./charts";
import { useVolatilityEvidence } from "./evidence";

/** Streamed index levels rebuild the board at most this often. */
const LIVE_LEVEL_THROTTLE_MS = 1_000;
const INDEX_LEVEL_REFRESH_MS = 15_000;
const TABS = [{ value: "curve", label: "Curve" }, { value: "history", label: "History" }, { value: "board", label: "Cross-asset" }];
const BOARD_COLUMNS: DataTableColumn[] = [
  { id: "id", label: "Index", width: 8, align: "left" },
  { id: "label", label: "Name", width: 17, align: "left" },
  { id: "value", label: "Level", width: 9, align: "right" },
  { id: "change1d", label: "1D pts", width: 9, align: "right" },
  { id: "change1dPercent", label: "1D %", width: 9, align: "right" },
  { id: "percentile1y", label: "1Y pctl", width: 9, align: "right" },
  { id: "date", label: "As of", width: 12, align: "left" },
];
const CURVE_COLUMNS: DataTableColumn[] = [
  { id: "tenor", label: "Tenor", width: 12, align: "left" },
  { id: "value", label: "IV %", width: 12, align: "right" },
];
const number = (value: number | null | undefined, signed = false) => value == null || !Number.isFinite(value)
  ? "--" : `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}`;
const percentile = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : value.toFixed(0);
const TERM_STATE_LABELS: Record<string, string> = { normal: "Contango", inverted: "Backwardation", flat: "Flat", partial: "Partial" };

export function VolatilityPane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const [initialTab] = usePaneSettingValue("initialTab", "curve");
  const [tab, setTab] = usePluginPaneState("activeTabId", initialTab);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedIndexId", "vix");
  const [sort, setSort] = useState<{ id: string | null; direction: "asc" | "desc" }>({ id: null, direction: "asc" });
  const [partial, setPartial] = useState<VolatilityLoadResult | null>(null);
  const controller = useRef<AbortController | null>(null);
  const request = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    return loadVolatilityData(force, undefined, { signal: abort.signal, onSnapshot: (snapshot) => {
      if (!abort.signal.aborted) setPartial(snapshot);
    } });
  }, []);
  const resource = useAsyncResource(request, { initialData: getCachedVolatilityData });
  useEffect(() => () => controller.current?.abort(), []);
  useAutoRefresh(resource.updatedAt, resource.load);
  const loaded = partial ?? resource.data;
  // Index levels stream through the shared quote layer for the tab on screen;
  // the history tab is FRED daily closes and subscribes nothing.
  const liveTargets = useMemo<QuoteSubscriptionTarget[]>(() => (tab === "curve" ? VOLATILITY_CURVE_INDICES
    : tab === "board" ? VOLATILITY_INDICES.filter((definition) => !(definition.id in IMPLIED_CORRELATION_ROWS)) : [])
    .map((definition) => ({ symbol: definition.symbol, exchange: "", surface: "monitor", visible: true,
      selected: definition.id === selectedId, weight: 40 })), [tab, selectedId]);
  const liveStreaming = useLiveStreamingSetting();
  const { entries: liveEntries } = useLiveQuoteEntries(liveTargets, { liveStreaming });
  const liveEntriesRef = useRef(liveEntries);
  liveEntriesRef.current = liveEntries;
  // Where an index does not stream, its level is re-read every 15 seconds in
  // session while visible; a streamed level younger than that is left alone.
  const refreshIndexLevels = useCallback(async () => {
    const coordinator = getSharedMarketDataCoordinator();
    const now = Date.now();
    const quiet = liveTargets.filter((target) => {
      const quote = resolveEntryData(liveEntriesRef.current.get(buildQuoteKey({ symbol: target.symbol, exchange: "" })));
      return !quote || now - (quote.receivedAt ?? quote.lastUpdated) >= INDEX_LEVEL_REFRESH_MS;
    });
    if (!coordinator || quiet.length === 0) return;
    await coordinator.loadQuotesBatch(quiet.map((target) => ({ symbol: target.symbol, exchange: "" })), { forceRefresh: true });
  }, [liveTargets]);
  // With streaming off the quote layer already polls every minute.
  useLiveSessionRefresh(refreshIndexLevels, INDEX_LEVEL_REFRESH_MS, liveStreaming && liveTargets.length > 0);
  const liveLevels = useThrottledValue(useMemo(() => {
    const levels = new Map<VolatilityIndexId, VolatilityLiveLevel>();
    for (const definition of VOLATILITY_INDICES) {
      const quote = resolveEntryData(liveEntries.get(buildQuoteKey({ symbol: definition.symbol, exchange: "" })));
      if (quote && !quote.stale && quote.price > 0 && Number.isFinite(quote.price) && Number.isFinite(quote.lastUpdated)) {
        levels.set(definition.id, { value: quote.price, observedAt: quote.lastUpdated });
      }
    }
    return levels;
  }, [liveEntries]), LIVE_LEVEL_THROTTLE_MS);
  // Rebuilt at most once a second from the loaded daily inputs plus the levels.
  const result = useMemo(() => !loaded || liveLevels.size === 0 ? loaded
    : { ...loaded, data: buildVolatilityData(withLiveVolatilityLevels(loaded.inputs, liveLevels)) }, [loaded, liveLevels]);
  const data = result?.data;
  // Indices without a level are reported in the notices, not as empty rows;
  // rows still loading keep their place so the board does not jump.
  const loading = !!result && result.loaded < result.total;
  const rows = useMemo(() => {
    const ordered = boardOrder(data?.board ?? []).filter((row) => row.value != null || (loading && !row.error));
    if (!sort.id) return ordered;
    const key = sort.id as keyof VolatilityBoardRow;
    return ordered.sort((left, right) => {
      const a = left[key], b = right[key];
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      return (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)))
        * (sort.direction === "asc" ? 1 : -1);
    });
  }, [data?.board, sort, loading]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  useVolatilityEvidence(result, tab, selected, resource.loading);
  const notices = [resource.error, ...(result?.errors ?? []), ...(data?.warnings ?? []),
    ...(selected?.warnings ?? [])].filter((notice): notice is string => !!notice);
  usePaneNoticeFooter({ registrationId: "volatility-notices", notices, focused });
  const cycleTab = () => setTab(TABS[(TABS.findIndex((entry) => entry.value === tab) + 1) % TABS.length]!.value);
  const handleKey = (event: DataTableKeyEvent) => {
    if (event.ctrl || event.alt || event.meta) return false;
    if (event.name === "v") cycleTab();
    else if (event.name === "r" && !resource.loading) void resource.reload();
    else return false;
    event.preventDefault?.(); event.stopPropagation?.(); return true;
  };
  useShortcut((event) => { if (focused && tab === "history") handleKey(event); });
  const asOf = tab === "history" ? data?.fred.termDate : tab === "board" ? selected?.date : data?.curve.date;
  // A level from the stream is labelled intraday with its time; closes keep their date.
  const intraday = (id: VolatilityIndexId | undefined, date: string | null | undefined) => {
    const level = id ? liveLevels.get(id) : undefined;
    return level && date === new Date(level.observedAt).toISOString().slice(0, 10) ? level : null;
  };
  const liveObservation = tab === "board" ? intraday(selected?.id, selected?.date)
    : tab === "curve" && data?.curve.source === "market-history" ? intraday("vix", data.curve.date) : null;
  const observationTime = liveObservation ? new Date(liveObservation.observedAt).toISOString()
    : selected?.sampleSize === 1 ? selected.history.at(-1)?.observedAt : null;
  const observationBasis = liveObservation ? "intraday" : tab === "history" ? "daily close"
    : tab === "board" && selected?.sampleSize === 1 ? "observation" : "daily history";
  usePaneFooter("volatility", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading volatility", tone: "muted" as const }] }] : []),
    ...(result?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ...(data ? [{ id: "basis", parts: [{ text: observationBasis, tone: "muted" as const }] }] : []),
    ...(asOf ? [{ id: "date", parts: [{ text: observationTime && (tab === "board" || liveObservation) ? `${observationTime.slice(0, 16).replace("T", " ")} UTC` : asOf, tone: "muted" as const }] }] : []),
  ], hints: [{ id: "view", key: "v", label: "iew", onPress: cycleTab }] }), [resource.loading, result?.stale, data, asOf, observationTime, observationBasis, tab, liveObservation]);
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused });
  const tabRows = tabsInHeader ? 0 : 1;
  const contentHeight = Math.max(5, height - tabRows);
  // The board needs only its rows; the selected index history takes the rest.
  const boardHeight = Math.max(5, Math.min(rows.length + 2, Math.floor(contentHeight * 0.62)));
  const curve = data?.curve;
  // The tenor table needs only its rows; the curve chart takes the rest.
  const curveTableHeight = Math.min(Math.max(2, (curve?.points.length ?? 0) + 1), 8, Math.max(4, Math.floor(contentHeight * 0.3)));
  const curveStats: StatItem[] = curve ? [
    { id: "structure", label: "Structure", value: TERM_STATE_LABELS[curve.termState] ?? curve.termState,
      tone: curve.termState === "inverted" ? "warning" : curve.termState === "normal" ? "positive" : "neutral" },
    { id: "ratio", label: "3M/30D", value: number(curve.ratio),
      detail: curve.ratio == null ? undefined : `${percentile(curve.ratioPercentile1y)} pctl 1Y` },
    { id: "spread", label: "Spread", value: `${number(curve.slope, true)} pts` },
  ] : [];
  const ready = !!data && (data.board.some((row) => row.value != null) || data.fred.metrics.some((metric) => metric.value != null));
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} variant="underline" dense focused={focused} />}
    <PaneStatusBody subject="volatility" loading={resource.loading && !ready} error={!ready ? resource.error ?? result?.errors[0] ?? null : null} empty={!resource.loading && !ready}>
      {data && tab === "curve" && <>
        <StatGrid items={curveStats} width={width} />
        <VolatilityCurveChart curve={data.curve} width={width} height={Math.max(4, contentHeight - curveTableHeight - statGridRows(curveStats, width))} />
        <DataTableView focused={focused} columns={CURVE_COLUMNS} items={data.curve.points} rootWidth={width} rootHeight={curveTableHeight}
          emptyStateTitle="VIX curve unavailable." getItemKey={(row) => row.id} selection={{ kind: "id", selectedId, getId: (row) => row.id, onChange: setSelectedId }}
          onActivate={(row) => { setSelectedId(row.id); setTab("board"); }} onRootKeyDown={handleKey}
          sortColumnId={null} sortDirection="asc"
          getExportMetadata={() => [["as of", data.curve.date], ["source", data.curve.source], ["units", "IV percent"], ["warnings", ...notices]]}
          renderCell={(row, column) => ({ text: column.id === "value" ? number(row.value) : String(row.tenor),
            color: row.value == null ? colors.textMuted : column.id === "value" ? colors.warning : colors.text })} />
      </>}
      {data && tab === "history" && <VolatilityHistoryChart fred={data.fred} width={width} height={contentHeight} />}
      {data && tab === "board" && <>
        <DataTableView<VolatilityBoardRow> focused={focused} columns={BOARD_COLUMNS} items={rows} rootWidth={width} rootHeight={boardHeight}
          emptyStateTitle="Volatility indices unavailable." getItemKey={(row) => row.id} selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelectedId }}
          onActivate={(row) => setSelectedId(row.id)} onRootKeyDown={handleKey}
          sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={(id) => setSort(id === sort.id && sort.direction === "desc" ? { id: null, direction: "asc" } : { id, direction: id === sort.id ? "desc" : "asc" })}
          getExportMetadata={() => [["basis", "daily history; sparse observations retain their timestamp"], ["percentile", "one year, at least 200 observations and 300 calendar days"], ["warnings", ...notices]]}
          renderCell={(row, column) => ({ text: column.id === "id" ? row.id.toUpperCase()
            : column.id === "label" ? row.label
            : column.id === "percentile1y" ? percentile(row.percentile1y)
            : ["value", "change1d", "change1dPercent"].includes(column.id)
              ? number(row[column.id as "value" | "change1d" | "change1dPercent"], column.id.startsWith("change"))
              : String(row.date ?? "--"),
            color: column.id.startsWith("change") && row.change1d != null ? row.change1d > 0 ? colors.warning : row.change1d < 0 ? colors.positive : colors.text
              : row.value == null ? colors.textMuted : colors.text })} />
        {selected && <>
          <Box height={1} paddingX={1}><Text fg={colors.textDim}>{`${selected.id.toUpperCase() === selected.label ? selected.label : `${selected.id.toUpperCase()} · ${selected.label}`} · ${selected.unit} · ${selected.date ?? "--"}`}</Text></Box>
          <VolatilityIndexHistoryChart row={selected} width={width} height={Math.max(3, contentHeight - boardHeight - 1)} />
        </>}
      </>}
    </PaneStatusBody>
  </Box>;
}
