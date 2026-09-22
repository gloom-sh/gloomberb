import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, DataTableView, KeyValueRow, PaneStatusBody, Tabs, usePaneFooter, usePaneNoticeFooter,
  type DataTableColumn, type DataTableKeyEvent } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue, usePluginPaneState } from "gloomberb/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text } from "../../../ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { getCachedVolatilityData, loadVolatilityData, type VolatilityLoadResult } from "./client";
import { boardOrder, sourceLabel, type VolatilityBoardRow } from "./model";
import { VolatilityCurveChart, VolatilityHistoryChart, VolatilityRatioChart, VolatilityIndexHistoryChart } from "./charts";
import { useVolatilityEvidence } from "./evidence";

const TABS = [{ value: "curve", label: "Curve" }, { value: "history", label: "History" }, { value: "board", label: "Cross-asset" }];
const BOARD_COLUMNS: DataTableColumn[] = [
  { id: "id", label: "Index", width: 8, align: "left" },
  { id: "label", label: "Name", width: 17, align: "left" },
  { id: "value", label: "Level", width: 9, align: "right" },
  { id: "change1d", label: "1D pts", width: 9, align: "right" },
  { id: "change1dPercent", label: "1D %", width: 9, align: "right" },
  { id: "percentile1y", label: "1Y pctl", width: 9, align: "right" },
  { id: "date", label: "As of", width: 12, align: "left" },
  { id: "status", label: "Coverage", width: 12, align: "left" },
];
const CURVE_COLUMNS: DataTableColumn[] = [
  { id: "tenor", label: "Tenor", width: 12, align: "left" },
  { id: "value", label: "IV %", width: 12, align: "right" },
  { id: "source", label: "Source", width: 22, align: "left" },
];
const number = (value: number | null | undefined, signed = false) => value == null || !Number.isFinite(value)
  ? "--" : `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}`;
const percentile = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : value.toFixed(0);

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
  const result = partial ?? resource.data;
  const data = result?.data;
  const rows = useMemo(() => {
    const ordered = boardOrder(data?.board ?? []);
    if (!sort.id) return ordered;
    const key = sort.id as keyof VolatilityBoardRow;
    return ordered.sort((left, right) => {
      const a = left[key], b = right[key];
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      return (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)))
        * (sort.direction === "asc" ? 1 : -1);
    });
  }, [data?.board, sort]);
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
  const observationTime = selected?.sampleSize === 1 ? selected.history.at(-1)?.observedAt : null;
  const observationBasis = tab === "history" ? "daily close" : tab === "board" && selected?.sampleSize === 1 ? "observation" : "daily history";
  const source = !data ? null : tab === "history" ? "FRED" : tab === "board" ? sourceLabel(selected?.source) : data?.curve.source === "fred" ? "FRED" : "market history";
  usePaneFooter("volatility", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading volatility", tone: "muted" as const }] }] : []),
    ...(result?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ...(source ? [{ id: "source", parts: [{ text: `${source} · ${observationBasis}`, tone: "muted" as const }] }] : []),
    ...(asOf ? [{ id: "date", parts: [{ text: observationTime && tab === "board" ? `${observationTime.slice(0, 16).replace("T", " ")} UTC` : asOf, tone: "muted" as const }] }] : []),
  ], hints: [{ id: "view", key: "v", label: "iew", onPress: cycleTab }] }), [resource.loading, result?.stale, source, asOf, observationTime, observationBasis, tab]);
  const contentHeight = Math.max(5, height - 1);
  // The board needs only its rows; the selected index history takes the rest.
  const boardHeight = Math.max(5, Math.min(rows.length + 2, Math.floor(contentHeight * 0.62)));
  const curveTableHeight = Math.min(8, Math.max(4, Math.floor(contentHeight * 0.3)));
  const historyHeight = Math.max(3, Math.floor(contentHeight * 0.6));
  const ready = !!data && (data.board.some((row) => row.value != null) || data.fred.metrics.some((metric) => metric.value != null));
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} variant="underline" dense focused={focused} />
    <PaneStatusBody subject="volatility" loading={resource.loading && !ready} error={!ready ? resource.error ?? result?.errors[0] ?? null : null} empty={!resource.loading && !ready}>
      {data && tab === "curve" && <>
        <Box height={1} flexDirection="row" paddingX={1} gap={3} overflow="hidden">
          <Badge label={data.curve.termState === "normal" ? "CONTANGO" : data.curve.termState === "inverted" ? "BACKWARDATION" : data.curve.termState.toUpperCase()}
            tone={data.curve.termState === "inverted" ? "warning" : data.curve.termState === "normal" ? "positive" : "neutral"} />
          <KeyValueRow label="3M/30D" labelWidth={7} value={number(data.curve.ratio)}
            detail={data.curve.ratioPercentile1y == null ? data.curve.ratio == null ? undefined : "pctl 1Y --" : `${percentile(data.curve.ratioPercentile1y)} pctl 1Y (${data.curve.ratioSampleSize})`} />
          <KeyValueRow label="Spread" labelWidth={7} value={`${number(data.curve.slope, true)} pts`} />
        </Box>
        <VolatilityCurveChart curve={data.curve} width={width} height={Math.max(4, contentHeight - curveTableHeight - 1)} />
        <DataTableView focused={focused} columns={CURVE_COLUMNS} items={data.curve.points} rootWidth={width} rootHeight={curveTableHeight}
          emptyStateTitle="VIX curve unavailable." getItemKey={(row) => row.id} selection={{ kind: "id", selectedId, getId: (row) => row.id, onChange: setSelectedId }}
          onActivate={(row) => { setSelectedId(row.id); setTab("board"); }} onRootKeyDown={handleKey}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}}
          getExportMetadata={() => [["as of", data.curve.date], ["source", data.curve.source], ["units", "IV percent"], ["warnings", ...notices]]}
          renderCell={(row, column) => ({ text: column.id === "value" ? number(row.value) : column.id === "source" ? sourceLabel(row.source) : String(row.tenor),
            color: row.value == null ? colors.textMuted : column.id === "value" ? colors.warning : colors.text })} />
      </>}
      {data && tab === "history" && <>
        <VolatilityHistoryChart fred={data.fred} width={width} height={historyHeight} />
        <VolatilityRatioChart fred={data.fred} width={width} height={Math.max(3, contentHeight - historyHeight)} />
      </>}
      {data && tab === "board" && <>
        <DataTableView<VolatilityBoardRow> focused={focused} columns={BOARD_COLUMNS} items={rows} rootWidth={width} rootHeight={boardHeight}
          emptyStateTitle="Volatility indices unavailable." getItemKey={(row) => row.id} selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelectedId }}
          onActivate={(row) => setSelectedId(row.id)} onRootKeyDown={handleKey}
          sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={(id) => setSort(id === sort.id && sort.direction === "desc" ? { id: null, direction: "asc" } : { id, direction: id === sort.id ? "desc" : "asc" })}
          getExportMetadata={() => [["basis", "daily history; sparse observations retain their timestamp"], ["percentile", "one year, at least 200 observations and 300 calendar days"], ["warnings", ...notices]]}
          renderCell={(row, column) => ({ text: column.id === "id" ? row.id.toUpperCase()
            : column.id === "label" ? row.label
            : column.id === "status" ? row.value == null && !row.error && result && result.loaded < result.total ? "loading"
              : row.status === "limited" ? `${row.sampleSize} obs` : row.status
              : column.id === "percentile1y" ? percentile(row.percentile1y)
              : ["value", "change1d", "change1dPercent"].includes(column.id)
                ? number(row[column.id as "value" | "change1d" | "change1dPercent"], column.id.startsWith("change"))
                : String(row.date ?? "--"),
            color: column.id.startsWith("change") && row.change1d != null ? row.change1d > 0 ? colors.warning : row.change1d < 0 ? colors.positive : colors.text
              : row.value == null ? colors.textMuted : colors.text })} />
        {selected && <>
          <Box height={1} paddingX={1}><Text fg={colors.textDim}>{`${selected.id.toUpperCase() === selected.label ? selected.label : `${selected.id.toUpperCase()} · ${selected.label}`} · ${selected.unit} · ${selected.date ?? "--"} · ${sourceLabel(selected.source)}`}</Text></Box>
          <VolatilityIndexHistoryChart row={selected} width={width} height={Math.max(3, contentHeight - boardHeight - 1)} />
        </>}
      </>}
    </PaneStatusBody>
  </Box>;
}
