import { useCallback, useMemo, useRef } from "react";
import {
  CompositeChart,
  DataTableView,
  EmptyState,
  PaneStatusBody,
  QueryBar,
  Tabs,
  usePaneFooter,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  usePaneTicker,
  type DataTableColumn,
  type DataTableKeyEvent,
  type SelectControl,
} from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneInstanceId, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadBacktestHistory } from "./client";
import { runBacktest, type BacktestResult, type BacktestTrade } from "./engine";
import { formatStat, SUMMARY_ROWS, type SummaryRow } from "./format";
import { BACKTEST_PRESETS, DEFAULT_PRESET, lookbackYears, resolveRules } from "./presets";
import { parseRule } from "./rules";

const TABS = [{ value: "summary", label: "Summary" }, { value: "trades", label: "Trades" }];
// Growth multiples on a log axis keep a 140x run and a flat decade readable together.
const PANELS = [{ id: "main", height: 0.72, scale: "log" as const }, { id: "drawdown", label: "Drawdown", height: 0.28 }];
const multiple = (value: number) => `\u00d7${value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2)}`;
const STRATEGY_OPTIONS = [...BACKTEST_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })), { value: "custom", label: "Custom rules" }];
const SUMMARY_COLUMNS: DataTableColumn[] = [
  { id: "metric", label: "Metric", width: 23, align: "left" },
  { id: "strategy", label: "Strategy", width: 10, align: "right" },
  { id: "benchmark", label: "Buy & hold", width: 10, align: "right" },
];
const TRADE_COLUMNS: DataTableColumn[] = [
  { id: "entryDate", label: "Entry", width: 11, align: "left" },
  { id: "entryPrice", label: "Entry px", width: 10, align: "right" },
  { id: "exitDate", label: "Exit", width: 11, align: "left" },
  { id: "exitPrice", label: "Exit px", width: 10, align: "right" },
  { id: "returnPct", label: "Return", width: 9, align: "right" },
  { id: "sessions", label: "Sessions", width: 9, align: "right" },
];
const SUMMARY_WIDTH = SUMMARY_COLUMNS.reduce((sum, column) => sum + column.width + 1, 4);
const noop = () => {};

function readRules(preset: string, entryText: string, exitText: string) {
  const rules = resolveRules(preset, entryText, exitText);
  try {
    return { ...rules, entry: parseRule(rules.entry), exit: parseRule(rules.exit), error: null };
  } catch (error) {
    return { ...rules, entry: null, exit: null, error: error instanceof Error ? error.message : "Invalid rule" };
  }
}

export function BacktestPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const paneId = usePaneInstanceId();
  const { openPaneSettings } = usePluginAppActions();
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const [preset, setPreset] = usePaneSettingValue("preset", DEFAULT_PRESET.id);
  const [entryText] = usePaneSettingValue("entry", DEFAULT_PRESET.entry);
  const [exitText] = usePaneSettingValue("exit", DEFAULT_PRESET.exit);
  const [lookback] = usePaneSettingValue("lookback", "10");
  const [costText] = usePaneSettingValue<string | number>("cost", "5");
  const [view, setView] = usePluginPaneState("backtest:view", "summary");
  const [selectedTrade, setSelectedTrade] = usePluginPaneState("backtest:trade", 0);
  const strategyControl = useRef<SelectControl>(null);
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const loader = useCallback((force: boolean) => loadBacktestHistory(instrument!, { forceRefresh: force }), [instrumentKey]);
  const history = useAsyncResource(instrument ? loader : null);
  useAutoRefresh(history.updatedAt, history.load);

  const rules = useMemo(() => readRules(preset, entryText, exitText), [preset, entryText, exitText]);
  const ruleStrings = resolveRules(preset, entryText, exitText);
  const costBps = Math.min(100, Math.max(0, Number(costText) || 0));
  const run = useMemo((): { result: BacktestResult | null; error: string | null } => {
    if (!history.data || !rules.entry || !rules.exit) return { result: null, error: null };
    try {
      return { result: runBacktest(history.data.bars, rules.entry, rules.exit, { lookbackYears: lookbackYears(lookback), costBps }), error: null };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : "Backtest failed" };
    }
  }, [history.data, rules, lookback, costBps]);
  const result = run.result;

  const series = useMemo(() => {
    if (!result) return [];
    const points = (pick: (row: BacktestResult["equity"][number]) => number) =>
      result.equity.map((row) => scalarPoint(new Date(row.date), pick(row)));
    // Buy-and-hold first so the strategy line draws on top where they coincide.
    return [
      staticSeries(points((row) => row.benchmark), { id: "benchmark", label: "Buy & hold", color: colors.textMuted, calendarSpaced: true }),
      staticSeries(points((row) => row.strategy), { id: "strategy", label: "Strategy", color: colors.positive, calendarSpaced: true }),
      { ...staticSeries(points((row) => row.drawdownPct), { id: "drawdown", label: "Strategy drawdown", color: colors.negative, calendarSpaced: true }), panelId: "drawdown" },
    ];
  }, [result, colors]);

  const edit = () => openPaneSettings(paneId);
  const cycleView = () => setView(view === "summary" ? "trades" : "summary");
  const handleKey = (event: DataTableKeyEvent | { name?: string; ctrl?: boolean; alt?: boolean; meta?: boolean; preventDefault?: () => void; stopPropagation?: () => void }) => {
    if (event.ctrl || event.alt || event.meta) return false;
    if (event.name === "r") void history.reload();
    else if (event.name === "e") edit();
    else if (event.name === "v") cycleView();
    else if (event.name === "tab") strategyControl.current?.open();
    else return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  };
  useShortcut((event) => { if (focused && view === "summary") handleKey(event); });

  const notices = [identityError, history.error, rules.error, run.error, ...(result?.warnings ?? [])]
    .filter((value): value is string => !!value);
  usePaneNoticeFooter({ registrationId: "backtest-notices", notices: [...new Set(notices)], focused });
  usePaneFooter("backtest", () => ({
    info: [
      ...(history.loading ? [{ id: "loading", parts: [{ text: "loading history", tone: "muted" as const }] }] : []),
      ...(result ? [{ id: "window", parts: [{ text: `${result.start} to ${result.end} · ${result.sessions} sessions`, tone: "muted" as const }] }] : []),
      { id: "fills", parts: [{ text: `next-open fills · ${costBps} bp/side${history.data?.source ? ` · ${history.data.source}` : ""}`, tone: "muted" as const }] },
    ],
    hints: [
      { id: "edit", key: "e", label: "dit rules", onPress: edit },
      { id: "view", key: "v", label: "iew", onPress: cycleView },
    ],
  }), [history.loading, history.data?.source, result, costBps, view, paneId]);

  const tabsInHeader = usePaneHeaderTabs(symbol ? { tabs: TABS, activeValue: view, onSelect: setView, focused } : null);
  if (!symbol) return <EmptyState title="Choose a ticker." hint="Open BT with a symbol, for example BT AAPL." />;
  const bodyHeight = Math.max(4, height - 1 - (tabsInHeader ? 0 : 1));
  const wide = width >= 120;
  const summaryTable = (tableWidth: number, tableHeight: number) => (
    <DataTableView<SummaryRow, DataTableColumn>
      focused={false}
      rootWidth={tableWidth}
      rootHeight={tableHeight}
      columns={SUMMARY_COLUMNS}
      items={SUMMARY_ROWS}
      getItemKey={(row) => row.id}
      selection={{ kind: "index", selectedIndex: -1, onChange: noop }}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={noop}
      emptyStateTitle="No statistics"
      renderCell={(row, column) => {
        if (column.id === "metric") return { text: row.label };
        const value = column.id === "strategy" ? row.strategy(result!) : row.benchmark?.(result!) ?? null;
        const text = formatStat(value);
        const signed = value?.kind === "signed" && value.value != null && value.value !== 0;
        return { text, color: signed ? (value!.value! > 0 ? colors.positive : colors.negative) : undefined };
      }}
    />
  );
  const chart = (chartWidth: number, chartHeight: number) => (
    <CompositeChart
      series={series}
      panels={PANELS}
      width={chartWidth}
      height={chartHeight}
      showLegend
      showTimeAxis
      navigable={false}
      formatAxisValue={(value, domain) => domain.seriesIds.includes("drawdown") ? `${value.toFixed(0)}%` : multiple(value)}
      formatValue={(value, series) => series.id === "drawdown" ? `${value.toFixed(1)}%` : multiple(value)}
      remoteKind="backtest-equity"
    />
  );
  return (
    <Box width={width} height={height} flexDirection="column">
      {!tabsInHeader && <Tabs tabs={TABS} activeValue={view} onSelect={setView} focused={focused} dense />}
      <QueryBar
        width={width}
        filters={[{
          id: "strategy",
          label: "Strategy",
          controlRef: strategyControl,
          value: STRATEGY_OPTIONS.some((option) => option.value === preset) ? preset : "custom",
          options: STRATEGY_OPTIONS,
          onChange: (value: string) => setPreset(value),
        }]}
        meta={`entry ${ruleStrings.entry} · exit ${ruleStrings.exit}`}
      />
      <PaneStatusBody
        loading={history.loading && !history.data}
        error={!history.data ? history.error : null}
        subject="price history"
      >
        {!result ? (
          <EmptyState title={rules.error ?? run.error ?? "No backtest yet."} hint={rules.error ? "Press e to edit the rules." : undefined} />
        ) : view === "trades" ? (
          <DataTableView<BacktestTrade, DataTableColumn>
            focused={focused}
            rootWidth={width}
            rootHeight={bodyHeight}
            columns={TRADE_COLUMNS}
            items={[...result.trades].reverse()}
            getItemKey={(trade) => trade.entryDate}
            selection={{ kind: "index", selectedIndex: selectedTrade, onChange: setSelectedTrade }}
            onRootKeyDown={handleKey}
            sortColumnId={null}
            sortDirection="desc"
            onHeaderClick={noop}
            renderCell={(trade, column) => ({
              text: column.id === "entryDate" ? trade.entryDate
                : column.id === "entryPrice" ? trade.entryPrice.toFixed(2)
                  : column.id === "exitDate" ? (trade.open ? "open" : trade.exitDate!)
                    : column.id === "exitPrice" ? (trade.exitPrice?.toFixed(2) ?? "--")
                      : column.id === "returnPct" ? (Math.abs(trade.returnPct) < 0.05 ? "0.0%" : `${trade.returnPct > 0 ? "+" : ""}${trade.returnPct.toFixed(1)}%`)
                        : String(trade.sessions),
              color: column.id === "returnPct" ? (Math.abs(trade.returnPct) < 0.05 ? undefined : trade.returnPct > 0 ? colors.positive : colors.negative)
                : trade.open && column.id === "exitDate" ? colors.warning : undefined,
            })}
            emptyStateTitle="No trades in this window."
          />
        ) : wide ? (
          <Box flexDirection="row" width={width} height={bodyHeight}>
            {chart(width - SUMMARY_WIDTH - 1, bodyHeight)}
            <Box width={1} />
            {summaryTable(SUMMARY_WIDTH, bodyHeight)}
          </Box>
        ) : (
          <Box flexDirection="column" width={width} height={bodyHeight}>
            {bodyHeight - SUMMARY_ROWS.length - 1 >= 8 ? chart(width, bodyHeight - SUMMARY_ROWS.length - 1) : null}
            {summaryTable(width, Math.min(bodyHeight, SUMMARY_ROWS.length + 1))}
          </Box>
        )}
      </PaneStatusBody>
    </Box>
  );
}
