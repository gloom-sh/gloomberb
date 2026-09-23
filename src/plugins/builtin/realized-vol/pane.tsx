import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, EmptyState, PaneStatusBody, QueryBar, StatGrid, statGridRows, Tabs, usePaneFooter, usePaneHeaderTabs, usePaneNoticeFooter,
  usePaneTicker, type DataTableColumn, type StatItem } from "../../../components";
import { instrumentFromTicker, quoteSubscriptionTargetFromTicker } from "../../../market-data/request-types";
import { useQuoteUpdates } from "../../../state/hooks/quote-streaming";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, useUiCapabilities } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { useLiveSessionRefresh } from "../shared/volatility/live-session";
import type { RealizedVolatilityEstimator, VolatilityConeStatistics } from "../shared/volatility";
import { loadCurrentAtmIv, loadRealizedVolatilityHistory, refreshCurrentAtmIv } from "./client";
import type { CurrentAtmIvSnapshot } from "./model";
import { projectRealizedVolatility } from "./model";
import { RealizedVolGraph, VolatilityConeChart } from "./charts";
import type { RealizedVolEvidenceStatus } from "./evidence";
import { DEFAULT_WINDOWS, ESTIMATOR_OPTIONS, selectedWindows } from "./settings";

/** In session, while visible, the current ATM IV reference re-reads its expiry this often. */
const ATM_IV_REFRESH_MS = 60_000;
const TABS = [{ value: "graph", label: "History" }, { value: "cone", label: "Cone" }];
const percent = (value: number | null | undefined) => value == null ? "--" : `${(value * 100).toFixed(2)}%`;
const CONE_COLUMNS: DataTableColumn[] = [
  { id: "window", label: "Sessions", width: 10, align: "left" },
  ...["current", "min", "max", "mean", "median"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), width: 11, align: "right" as const })),
  { id: "percentile", label: "Percentile", width: 12, align: "right" },
  { id: "sampleSize", label: "Samples", width: 10, align: "right" },
];

export function RealizedVolPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const { symbol, ticker, financials, error: identityError } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [initialView] = usePaneSettingValue("initialView", "graph");
  const [view, setView] = usePluginPaneState("activeTabId", initialView);
  const [estimatorValue, setEstimator] = usePaneSettingValue("estimator", "close-to-close");
  const [windowValue] = usePaneSettingValue<string[] | string>("windows", DEFAULT_WINDOWS);
  const [lookback, setLookback] = usePaneSettingValue("lookbackYears", "1");
  const [showIv, setShowIv] = usePaneSettingValue("showIv", true);
  const [selected, setSelected] = usePluginPaneState("selectedWindow", 30);
  const [sort, setSort] = useState<{ id: keyof VolatilityConeStatistics; direction: "asc" | "desc" }>({ id: "window", direction: "asc" });
  const estimator = ESTIMATOR_OPTIONS.find((option) => option.value === estimatorValue)?.value ?? "close-to-close";
  const windows = useMemo(() => selectedWindows(windowValue), [windowValue]);
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const historyController = useRef<AbortController | null>(null);
  const ivController = useRef<AbortController | null>(null);
  const historyLoader = useCallback(async (force: boolean) => {
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    const snapshot = await loadRealizedVolatilityHistory({ instrument: instrument!, forceRefresh: force, signal: controller.signal });
    if (!snapshot.history.length && snapshot.error) throw new Error(snapshot.error);
    return snapshot;
  }, [instrumentKey]);
  const quote = financials?.quote;
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const spotAvailable = !!quote && Number.isFinite(quote.price) && quote.price > 0 && !quote.stale;
  const ivLoader = useCallback(async (force: boolean) => {
    ivController.current?.abort();
    const controller = new AbortController();
    ivController.current = controller;
    const currentQuote = quoteRef.current!;
    return loadCurrentAtmIv({ instrument: instrument!, spot: currentQuote.price, spotAsOf: currentQuote.lastUpdated,
      forceRefresh: force, signal: controller.signal });
  }, [instrumentKey, spotAvailable]);
  const history = useAsyncResource(instrument ? historyLoader : null);
  const loadedIv = useAsyncResource(instrument && showIv && spotAvailable ? ivLoader : null);
  useEffect(() => () => historyController.current?.abort(), [historyLoader]);
  useEffect(() => () => ivController.current?.abort(), [ivLoader, showIv]);
  useAutoRefresh(history.updatedAt, history.load);
  useAutoRefresh(loadedIv.updatedAt, loadedIv.load);
  // The pane subscribes its own quote: the IV reference is fitted at the live
  // price even when no other pane streams this ticker. The price is only
  // sampled at each refresh, so the slow off-screen cadence is enough.
  const liveStreaming = useLiveStreamingSetting();
  const quoteTarget = quoteSubscriptionTargetFromTicker(ticker, symbol, "provider");
  useQuoteUpdates(quoteTarget ? [{ ...quoteTarget, surface: "detail", visible: false, weight: 70 }] : [], { liveStreaming });
  // In session the reference's own expiry is re-read every minute; the full
  // load that chose it still runs on the global refresh.
  const [refreshedIv, setRefreshedIv] = useState<{ owner: typeof ivLoader; at: number; data: CurrentAtmIvSnapshot } | null>(null);
  const ivDataRef = useRef<CurrentAtmIvSnapshot | null>(null);
  const refreshIv = useCallback(async () => {
    const previous = ivDataRef.current;
    const currentQuote = quoteRef.current;
    if (!previous?.reference || !instrument || !currentQuote || currentQuote.stale || !(currentQuote.price > 0)) return;
    ivController.current?.abort();
    const controller = new AbortController();
    ivController.current = controller;
    const owner = ivLoader;
    const data = await refreshCurrentAtmIv({ instrument, spot: currentQuote.price, spotAsOf: currentQuote.lastUpdated,
      signal: controller.signal }, previous);
    if (!controller.signal.aborted) setRefreshedIv({ owner, at: Date.now(), data });
  }, [ivLoader]);
  const refreshedCurrent = refreshedIv?.owner === ivLoader && refreshedIv.at > (loadedIv.updatedAt ?? 0) ? refreshedIv.data : null;
  const iv = { ...loadedIv, data: refreshedCurrent ?? loadedIv.data };
  ivDataRef.current = iv.data;
  useLiveSessionRefresh(refreshIv, ATM_IV_REFRESH_MS, showIv && spotAvailable && !!iv.data?.reference && !loadedIv.loading,
    loadedIv.updatedAt);
  const model = useMemo(() => history.data ? projectRealizedVolatility(history.data.history, {
    symbol: history.data.symbol, estimator, windows, lookbackYears: Number(lookback) === 2 ? 2 : 1,
  }) : null, [history.data, estimator, windows, lookback]);
  const chartInput = useMemo(() => model ? { history: model.history, rolling: model.series, windows: model.windows,
    currency: quote?.currency ?? "", iv: showIv ? iv.data?.reference ?? null : null } : null,
  [model, quote?.currency, showIv, iv.data]);
  const notices = [identityError, history.error, history.data?.error, iv.error, iv.data?.error,
    ...(model?.warnings ?? []), ...(showIv ? iv.data?.warnings ?? [] : []),
    ...(showIv && symbol && !spotAvailable ? ["Current ATM IV unavailable: underlying quote is missing or stale"] : []),
  ].filter((value): value is string => !!value);
  usePaneNoticeFooter({ registrationId: "realized-vol-notices", notices: [...new Set(notices)], focused });
  const cycleView = () => setView(view === "graph" ? "cone" : "graph");
  const openSurface = () => { if (symbol) createPaneFromTemplate("vol-surface-pane", { symbol, ticker, instrument: instrument?.instrument,
    ...(ticker ? { listing: { name: ticker.metadata.name, exchange: ticker.metadata.exchange,
      currency: ticker.metadata.currency, type: ticker.metadata.assetCategory ?? "STK" } } : {}),
    values: iv.data?.reference ? { expiration: String(iv.data.reference.expiration) } : {} }); };
  // The footer hints bind v, i and s in every view and state; only the reload
  // is the pane's own key.
  useShortcut((event) => {
    if (event.defaultPrevented || !isPlainKey(event, "r")) return;
    event.preventDefault(); event.stopPropagation();
    void history.reload();
    if (showIv) void iv.reload();
  }, { enabled: focused });
  usePaneFooter("realized-vol", () => ({ info: [
    ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
    ...(history.data?.stale ? [{ id: "stale", parts: [{ text: "stale history", tone: "warning" as const }] }] : []),
    ...(history.data ? [{ id: "cadence", parts: [{ text: "daily closes", tone: "muted" as const }] }] : []),
    ...(model?.asOf ? [{ id: "date", parts: [{ text: model.asOf.toISOString().slice(0, 10), tone: "muted" as const }] }] : []),
    ...(showIv && iv.loading ? [{ id: "iv-loading", parts: [{ text: "loading ATM IV", tone: "muted" as const }] }] : []),
  ], hints: [
    { id: "view", key: "v", label: "iew", onPress: cycleView },
    { id: "iv", key: "i", label: showIv ? "v off" : "v on", onPress: () => setShowIv(!showIv) },
    ...(symbol ? [{ id: "surface", key: "s", label: "urface", onPress: openSurface }] : []),
  ] }), [history.loading, history.data, model?.asOf, iv.loading, showIv, view, symbol, iv.data]);
  const evidence: RealizedVolEvidenceStatus = {
    symbol: model?.symbol ?? symbol ?? "", view: view === "cone" ? "cone" : "graph", estimator,
    windows, lookbackYears: Number(lookback) === 2 ? 2 : 1, showIv,
    loading: history.loading || (showIv && iv.loading),
    stale: history.data?.stale ?? false, source: history.data?.source ?? null,
    asOf: model?.asOf?.toISOString() ?? null,
    errors: [...new Set([history.error, history.data?.error, ...(model?.warnings ?? []),
      ...(showIv ? [iv.error, iv.data?.error, !iv.data?.reference ? "Current ATM IV unavailable" : null] : []),
    ].filter((value): value is string => !!value))],
    currentIv: showIv && iv.data?.reference ? { value: iv.data.reference.value * 100,
      date: iv.data.reference.date.toISOString(), label: iv.data.reference.label,
      source: iv.data.reference.source, expiration: iv.data.reference.expiration } : null,
  };
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: view, onSelect: setView, focused });
  const tabRows = tabsInHeader ? 0 : 1;
  const reference = showIv ? iv.data?.reference ?? null : null;
  // The cone has no IV line of its own, so the dated ATM IV it is read against sits above it.
  const coneStats: StatItem[] = view === "cone" && model && reference
    ? [{ id: "atm-iv", label: "ATM IV", value: percent(reference.value), detail: `${Math.round(reference.daysToExpiry)}d` }] : [];
  const contentHeight = Math.max(4, height - 1 - tabRows - statGridRows(coneStats, width));
  const sortedCone = [...(model?.cone ?? [])].sort((left, right) => {
    const a = left[sort.id], b = right[sort.id];
    return a == null ? b == null ? 0 : 1 : b == null ? -1 : (a - b) * (sort.direction === "asc" ? 1 : -1);
  });
  const coneTableHeight = Math.min(Math.max(2, sortedCone.length + 1), 10, Math.max(4, Math.floor(contentHeight * 0.42)));
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={view} onSelect={setView} variant="underline" dense focused={focused} />}
    <QueryBar width={width} filters={[
      { id: "estimator", label: "Estimator", value: estimator, options: ESTIMATOR_OPTIONS, onChange: (value: string) => setEstimator(value as RealizedVolatilityEstimator) },
      { id: "lookback", label: "Lookback", value: String(lookback), options: [{ value: "1", label: "1Y" }, { value: "2", label: "2Y" }], onChange: setLookback },
    ]} meta={reference ? `ATM IV observed ${reference.date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Annualized %"} />
    {!symbol ? <EmptyState title="Choose a ticker." /> : <PaneStatusBody subject="realized volatility" loading={history.loading && !model}
      error={!model ? history.error ?? identityError ?? null : null} empty={!!model && !model.history.length}>
      {model && view === "cone" ? <>
        <StatGrid items={coneStats} width={width} />
        <DataTableView<VolatilityConeStatistics> focused={focused} columns={CONE_COLUMNS} items={sortedCone}
          rootWidth={width} rootHeight={coneTableHeight} getItemKey={(row) => String(row.window)}
          sortColumnId={sort.id} sortDirection={sort.direction} emptyStateTitle="Volatility cone unavailable."
          onHeaderClick={(id) => setSort({ id: id as keyof VolatilityConeStatistics, direction: sort.id === id && sort.direction === "asc" ? "desc" : "asc" })}
          selection={{ kind: "id", selectedId: String(selected), getId: (row) => String(row.window), onChange: (_id, row) => setSelected(row.window) }}
          onActivate={(row) => setSelected(row.window)}
          getExportMetadata={() => [["symbol", model.symbol], ["estimator", model.estimator], ["lookback years", model.lookbackYears],
            ["as of", model.asOf?.toISOString()], ["source", history.data?.source], ["units", "annualized %"], ["warnings", ...notices]]}
          renderCell={(row, column) => ({ text: column.id === "window" ? String(row.window)
            : column.id === "sampleSize" ? String(row.sampleSize)
              : column.id === "percentile" ? row.percentile == null ? "--" : `${row.percentile.toFixed(1)}%`
                : percent(row[column.id as "current" | "min" | "max" | "mean" | "median"]),
            color: column.id === "current" ? colors.warning : colors.text })} />
        {/* Desktop chrome runs a little taller than its rows; the spare row keeps the last window in view. */}
        <VolatilityConeChart evidence={evidence} rows={model.cone} width={width}
          height={Math.max(3, contentHeight - coneTableHeight - (nativePaneChrome ? 1 : 0))} focused={focused} />
      </> : chartInput && windows.length ? <RealizedVolGraph evidence={evidence} input={chartInput} width={width} height={contentHeight} focused={focused} />
        : <EmptyState title="Select graph windows in pane settings." />}
    </PaneStatusBody>}
  </Box>;
}
