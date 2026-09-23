import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, EmptyState, PaneStatusBody, QueryBar, usePaneFooter, usePaneNoticeFooter, usePaneTicker, type DataTableColumn, type DataTableKeyEvent } from "../../../components";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue, usePluginAppActions } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadRealizedVolatilityHistory } from "../realized-vol/client";
import { IvHistoryChart } from "./charts";
import { loadIvHistory } from "./client";
import { formatRank, formatStat, statSource } from "./format";
import { HV_WINDOWS, type HvWindow, type IvLookback, type IvStatRow, projectIvHistory } from "./model";

const LOOKBACKS = [{ value: "1Y", label: "1Y" }, { value: "2Y", label: "2Y" }, { value: "ALL", label: "All" }];
const HV_OPTIONS = HV_WINDOWS.map((window) => ({ value: String(window), label: `HV ${window}` }));
const STAT_COLUMNS: DataTableColumn[] = [
  { id: "label", label: "Measure", width: 16, align: "left" },
  { id: "value", label: "Current", width: 9, align: "right" },
  { id: "date", label: "As of", width: 17, align: "left" },
  { id: "low", label: "52w low", width: 9, align: "right" },
  { id: "high", label: "52w high", width: 9, align: "right" },
  { id: "rank", label: "Rank", width: 6, align: "right" },
  { id: "percentile", label: "Pctl", width: 6, align: "right" },
  { id: "samples", label: "Sessions", width: 9, align: "right" },
];

export function IvHistoryPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [lookbackValue, setLookback] = usePaneSettingValue("lookback", "1Y");
  const [hvValue, setHvWindow] = usePaneSettingValue("hvWindow", "20");
  const lookback: IvLookback = lookbackValue === "2Y" || lookbackValue === "ALL" ? lookbackValue : "1Y";
  const hvWindow: HvWindow = Number(hvValue) === 30 ? 30 : 20;
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const controller = useRef<AbortController | null>(null);
  const [statSelectionValue, setStatSelection] = useState<string | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const [payload, prices] = await Promise.all([
      loadIvHistory(instrument!.symbol, { signal: current.signal }),
      loadRealizedVolatilityHistory({ instrument: instrument!, forceRefresh: force, signal: current.signal }),
    ]);
    return { payload, prices };
  }, [instrumentKey]);
  const resource = useAsyncResource(instrument ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const model = useMemo(() => resource.data
    ? projectIvHistory(resource.data.payload, resource.data.prices.history, { lookback, hvWindow }) : null,
  [resource.data, lookback, hvWindow]);
  // A queued symbol backfills within minutes; check back while it does.
  useEffect(() => {
    if (!model || model.status === "ready" || model.status === "unavailable") return;
    const timer = setTimeout(() => { void resource.reload(); }, 60_000);
    return () => clearTimeout(timer);
  }, [model?.status, resource.updatedAt]);
  const notices = [identityError, resource.error, resource.data?.prices.error, ...(model?.warnings ?? [])]
    .filter((value): value is string => !!value);
  usePaneNoticeFooter({ registrationId: "iv-history-notices", notices: [...new Set(notices)], focused });
  const cycleLookback = () => setLookback(lookback === "1Y" ? "2Y" : lookback === "2Y" ? "ALL" : "1Y");
  const toggleHv = () => setHvWindow(String(hvWindow === 20 ? 30 : 20));
  const openSurface = () => { if (symbol) createPaneFromTemplate("vol-surface-pane", { symbol, ticker, instrument: instrument?.instrument }); };
  const handleKey = (event: DataTableKeyEvent): boolean => {
    if (event.ctrl || event.alt || event.meta) return false;
    if (event.name === "r") void resource.reload();
    else if (event.name === "l") cycleLookback();
    else if (event.name === "h") toggleHv();
    else if (event.name === "s" && symbol) openSurface();
    else return false;
    event.preventDefault?.(); event.stopPropagation?.(); return true;
  };
  // The statistics table owns keys once it renders; before that the pane does.
  useShortcut((event) => { if (focused && !model) handleKey(event); });
  usePaneFooter("iv-history", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(model?.since ? [{ id: "since", parts: [{ text: `OPRA trade closes since ${model.since}`, tone: "muted" as const }] }] : []),
    ...(model?.asOf ? [{ id: "date", parts: [{ text: model.asOf, tone: "muted" as const }] }] : []),
  ], hints: [
    { id: "lookback", key: "l", label: "ookback", onPress: cycleLookback },
    { id: "hv", key: "h", label: "v window", onPress: toggleHv },
    ...(symbol ? [{ id: "surface", key: "s", label: "urface", onPress: openSurface }] : []),
  ] }), [resource.loading, model?.since, model?.asOf, lookback, hvWindow, symbol]);

  const statsHeight = model ? model.stats.length + 1 : 0;
  const statSelection = statSelectionValue ?? model?.stats[0]?.id ?? "";
  const statCell = (row: IvStatRow, id: string): { text: string; color?: string } => {
    const tone = row.percentile == null ? colors.text : row.percentile >= 80 ? colors.negative : row.percentile <= 20 ? colors.positive : colors.text;
    switch (id) {
      case "label": return { text: row.label, color: colors.textBright };
      case "value": return { text: formatStat(row.value, row.unit), color: row.id.startsWith("iv30") ? colors.warning : colors.textBright };
      case "date": return { text: row.date ? `${row.date} ${statSource(row)}` : "--", color: colors.textDim };
      case "low": return { text: formatStat(row.low, row.unit), color: colors.textDim };
      case "high": return { text: formatStat(row.high, row.unit), color: colors.textDim };
      case "rank": return { text: formatRank(row.rank), color: tone };
      case "percentile": return { text: formatRank(row.percentile), color: tone };
      case "samples": return { text: row.samples ? String(row.samples) : "--", color: colors.textDim };
      default: return { text: "" };
    }
  };
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} filters={[
      { id: "lookback", label: "Lookback", value: lookback, options: LOOKBACKS, onChange: setLookback },
      { id: "realized", label: "Realized", value: String(hvWindow), options: HV_OPTIONS, onChange: setHvWindow },
    ]} />
    {!symbol ? <EmptyState title="Choose a ticker." /> : <PaneStatusBody subject="implied volatility history" loading={resource.loading && !model}
      error={!model ? resource.error ?? identityError ?? null : null} empty={!!model && !model.iv30.length && !model.quoteIv30.length}
      emptyTitle={model?.status === "queued" || model?.status === "backfilling" ? `Backfilling ${symbol} implied volatility history...` : undefined}>
      {model ? <>
        <DataTableView<IvStatRow> focused={focused} columns={STAT_COLUMNS} items={model.stats} rootWidth={width} rootHeight={statsHeight}
          getItemKey={(row) => row.id} emptyStateTitle="No statistics." sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}}
          selection={{ kind: "id", selectedId: statSelection, getId: (row) => row.id, onChange: (id) => setStatSelection(id) }}
          getExportMetadata={() => [["symbol", model.symbol], ["as of", model.asOf], ["history since", model.since],
            ["IV", "ATM, constant maturity, annualized"], ["HV", `${hvWindow}-session close-to-close`], ["warnings", ...notices]]}
          onRootKeyDown={handleKey} renderCell={(row, column) => statCell(row, column.id)} />
        <IvHistoryChart model={model} width={width} height={Math.max(6, height - 2 - statsHeight)} hvLabel={`HV ${hvWindow}`} />
      </> : null}
    </PaneStatusBody>}
  </Box>;
}
