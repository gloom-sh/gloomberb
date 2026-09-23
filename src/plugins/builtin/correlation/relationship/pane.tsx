import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CompositeChart,
  PaneStatusBody,
  QueryBar,
  StatGrid,
  statGridRows,
  usePaneFooter,
  usePaneNoticeFooter,
  type CompositeAxisDomain,
} from "../../../../components";
import { StaticScatterChartSurface, type MultiLineChartSeries } from "../../../../components/chart/static";
import { scalarPoint, staticSeries } from "../../../../components/chart/static/series";
import { useShortcut, type KeyEventLike } from "../../../../react/input";
import { usePaneInstance } from "../../../../state/app/context";
import { colors } from "../../../../theme/colors";
import { formatTickerListInput } from "../../../../tickers/list";
import type { ResolvedSeries } from "../../../../time-series/types";
import type { PaneProps, PaneTemplateDef } from "../../../../types/plugin";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import { formatNumber } from "../../../../utils/format";
import { usePluginPaneState } from "../../../runtime";
import { useBoundTicker } from "../../shared/ticker-request";
import { useRelationshipHistories } from "./history";
import {
  DEFAULT_RELATIONSHIP_CORRELATION_WINDOW,
  DEFAULT_RELATIONSHIP_SECOND_SYMBOL,
  RELATIONSHIP_CORRELATION_WINDOWS,
  RELATIONSHIP_GRAPH_PANE_ID,
  RELATIONSHIP_RANGES,
  buildRelationshipAnalysis,
  buildRelationshipGraphPaneTitle,
  nextRelationshipRange,
  nextRelationshipWindow,
  relationshipSymbolsFromPaneSettings,
  relationshipTemplateSymbols,
  type RelationshipRange,
} from "./model";
import {
  buildIndexedPriceSeries,
  buildRelationshipCorrelationSeries,
  buildRelationshipRatioSeries,
  buildRelationshipScatterPointsForDate,
  buildRelationshipStatItems,
} from "./view-model";

export {
  RELATIONSHIP_GRAPH_PANE_ID, buildRelationshipAnalysis,
  buildRelationshipGraphSettingsDef
} from "./model";

type RelationshipGraphShortcut =
  | "range"
  | "window"
  | "correlation"
  | "regression"
  | "refresh"
  | { range: RelationshipRange };

/**
 * [t]ime range cycles and 1-6 pick a range, [p]eriod cycles the correlation
 * window, [c]orr and [f]it toggle their panels. The query bar shows all four,
 * so none needs a footer hint. `r` refreshes this pair's history.
 */
export function resolveRelationshipGraphShortcut(
  event: Pick<KeyEventLike, "name" | "key" | "ctrl" | "shift" | "alt" | "meta" | "super">,
): RelationshipGraphShortcut | null {
  if (event.ctrl || event.shift || event.alt || event.meta || event.super) return null;

  const key = (event.name ?? event.key ?? "").toLowerCase();
  switch (key) {
    case "r":
      return "refresh";
    case "t":
      return "range";
    case "p":
      return "window";
    case "c":
      return "correlation";
    case "f":
      return "regression";
  }
  const range = /^[1-9]$/.test(key) ? RELATIONSHIP_RANGES[Number(key) - 1] : undefined;
  return range ? { range } : null;
}

const RANGE_OPTIONS = RELATIONSHIP_RANGES.map((range, index) => ({ label: range, value: range, hint: String(index + 1) }));
const WINDOW_OPTIONS = RELATIONSHIP_CORRELATION_WINDOWS.map((window) => ({ label: `${window} obs`, value: String(window) }));
const REGRESSION_COLOR = "#ffd43b";
/** The ratio shares one legend with both price lines, so it takes its own hue. */
const RATIO_COLOR = "#e599f7";
/** Legend and time axis around the stacked panels. */
const CHART_CHROME_ROWS = 2;
/** The scatter's two label rows around a readable plot. */
const MIN_SCATTER_ROWS = 8;
const MIN_PANEL_ROWS = 3;

/** Each panel's axis reads at its own precision: whole index points, a ratio, a correlation. */
function formatAxisValue(value: number, domain: CompositeAxisDomain): string {
  if (domain.seriesIds.includes("ratio")) return formatNumber(value, Math.abs(value) >= 10 ? 1 : 3);
  if (domain.seriesIds.includes("correlation")) return formatNumber(value, 2);
  return formatNumber(value, 0);
}

function formatLegendValue(value: number, series: ResolvedSeries): string {
  if (series.id === "ratio") return formatNumber(value, 3);
  if (series.id === "correlation") return formatNumber(value, 2);
  return formatNumber(value, 1);
}

function panelSeries(series: MultiLineChartSeries[], panelId: string): ResolvedSeries[] {
  return series.map((entry) => ({
    ...staticSeries(
      entry.points.map((point) => scalarPoint(point.date, point.value)),
      { id: entry.id, label: entry.label, color: entry.color },
    ),
    panelId,
  }));
}

/**
 * Rows for the stacked chart and the scatter under it, in priority order:
 * price, ratio, rolling correlation, then the scatter. A short pane drops the
 * lowest-priority piece instead of squeezing every plot, and anything hidden
 * hands its rows to the chart.
 */
export function relationshipLayout(
  rows: number,
  { showCorrelation, showScatter }: { showCorrelation: boolean; showScatter: boolean },
): { chartRows: number; scatterRows: number; ratio: boolean; correlation: boolean } {
  const available = Math.max(0, rows);
  const panelRowsFor = (panels: number) => CHART_CHROME_ROWS + MIN_PANEL_ROWS * panels;
  const ratio = available >= panelRowsFor(2);
  const correlation = showCorrelation && available >= panelRowsFor(3);
  const panelCount = 1 + Number(ratio) + Number(correlation);
  const scatterRows = Math.max(MIN_SCATTER_ROWS, Math.floor(available * 0.3));
  const scatter = showScatter && available - scatterRows >= panelRowsFor(panelCount) + MIN_PANEL_ROWS;
  return {
    chartRows: scatter ? available - scatterRows : available,
    scatterRows: scatter ? scatterRows : 0,
    ratio,
    correlation,
  };
}

export function RelationshipGraphPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { symbol, exchange } = useBoundTicker();
  const pair = useMemo(() => relationshipSymbolsFromPaneSettings(pane?.settings, symbol), [pane?.settings, symbol]);
  const [range, setRange] = usePluginPaneState<RelationshipRange>("range", "1Y");
  const [correlationWindow, setCorrelationWindow] = usePluginPaneState<number>(
    "correlationWindow",
    DEFAULT_RELATIONSHIP_CORRELATION_WINDOW,
  );
  const [showCorrelation, setShowCorrelation] = usePluginPaneState<boolean>("showCorrelation", true);
  const [showRegression, setShowRegression] = usePluginPaneState<boolean>("showRegression", true);
  const [cursorDateMs, setCursorDateMs] = useState<number | null>(null);
  const { nativePaneChrome } = useUiCapabilities();
  const { data, loading, error, reload, updatedAt } = useRelationshipHistories(pair, range, exchange);
  const left = data?.[0] ?? null;
  const right = data?.[1] ?? null;
  const analysis = useMemo(() => (
    left && right ? buildRelationshipAnalysis(left.points, right.points, correlationWindow) : null
  ), [correlationWindow, left, right]);
  const cycleRange = useCallback(() => setRange((current) => nextRelationshipRange(current)), [setRange]);
  const cycleWindow = useCallback(() => setCorrelationWindow((current) => nextRelationshipWindow(current)), [setCorrelationWindow]);
  const toggleCorrelation = useCallback(() => setShowCorrelation((current) => !current), [setShowCorrelation]);
  const toggleRegression = useCallback(() => setShowRegression((current) => !current), [setShowRegression]);
  const leftSymbol = pair?.[0] ?? left?.symbol ?? "";
  const rightSymbol = pair?.[1] ?? right?.symbol ?? "";
  const stats = analysis?.stats ?? null;
  const statItems = useMemo(() => buildRelationshipStatItems(stats), [stats]);
  const statRows = statItems.length > 0 ? statGridRows(statItems, width) : 0;
  const layout = relationshipLayout(height - 1 - statRows, {
    showCorrelation,
    showScatter: showRegression,
  });
  const alignedDates = useMemo(() => analysis?.aligned.map((entry) => entry.date) ?? [], [analysis]);
  const cursorDate = useMemo(() => {
    if (alignedDates.length === 0) return null;
    if (cursorDateMs !== null && alignedDates.some((date) => date.getTime() === cursorDateMs)) {
      return new Date(cursorDateMs);
    }
    return alignedDates.at(-1) ?? null;
  }, [alignedDates, cursorDateMs]);
  const chartSeries = useMemo(() => {
    if (!analysis) return [];
    return [
      ...panelSeries(buildIndexedPriceSeries(analysis.aligned, leftSymbol, rightSymbol), "price"),
      ...(layout.ratio
        ? panelSeries(buildRelationshipRatioSeries(analysis.aligned, leftSymbol, rightSymbol, RATIO_COLOR), "ratio")
        : []),
      ...(layout.correlation
        ? panelSeries(buildRelationshipCorrelationSeries(analysis.aligned, analysis.correlationPoints), "correlation")
        : []),
    ];
  }, [analysis, layout.correlation, layout.ratio, leftSymbol, rightSymbol]);
  const panels = useMemo(() => [
    { id: "price", height: 0.4 },
    ...(layout.ratio ? [{ id: "ratio", height: 0.3 }] : []),
    ...(layout.correlation ? [{ id: "correlation", height: 0.3 }] : []),
  ], [layout.correlation, layout.ratio]);
  const scatterPoints = useMemo(
    () => analysis ? buildRelationshipScatterPointsForDate(analysis.returns, cursorDate) : [],
    [analysis, cursorDate],
  );
  const selectCursorDate = useCallback((date: Date | null) => {
    // Leaving the plot keeps the last date, so the scatter highlight stays put.
    if (date) setCursorDateMs(date.getTime());
  }, []);

  useEffect(() => {
    if (!analysis?.aligned.length) return;
    setCursorDateMs((current) => {
      if (current !== null && analysis.aligned.some((entry) => entry.date.getTime() === current)) return current;
      return analysis.aligned.at(-1)?.date.getTime() ?? null;
    });
  }, [analysis]);

  useShortcut((event) => {
    if (!focused) return;
    const shortcut = resolveRelationshipGraphShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof shortcut === "object") {
      setRange(shortcut.range);
      return;
    }
    switch (shortcut) {
      case "refresh":
        void reload();
        return;
      case "range":
        cycleRange();
        return;
      case "window":
        cycleWindow();
        return;
      case "correlation":
        toggleCorrelation();
        return;
      case "regression":
        toggleRegression();
        return;
    }
  });

  usePaneNoticeFooter({
    registrationId: "relationship-warnings", focused,
    notices: [
      ...(error ? [`${error}${data && updatedAt ? ` Retained history retrieved ${new Date(updatedAt).toISOString()}.` : ""}`] : []),
      ...(analysis?.unavailableReason ? [analysis.unavailableReason] : []),
      ...(analysis?.correlationUnavailableReason ? [analysis.correlationUnavailableReason] : []),
    ],
  });

  // The legend reads the values at the cursor and the axis carries its date,
  // so the footer only reports loading.
  usePaneFooter("relationship-graph", () => ({
    info: loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : [],
  }), [loading]);

  if (!pair) {
    return (
      <PaneStatusBody empty emptyTitle="No relationship tickers configured." />
    );
  }

  const queryBar = (
    <QueryBar
      width={width}
      filters={[
        // Six segments need most of a narrow bar; below that the range is a menu so
        // Corr and Fit stay on screen. Digits and `t` pick a range either way.
        { id: "range", label: "Range", inline: width >= (nativePaneChrome ? 72 : 90), value: range, options: RANGE_OPTIONS,
          onChange: (value: string) => setRange(value as RelationshipRange) },
        { id: "window", label: "Window", title: "Rolling correlation window", value: String(correlationWindow),
          options: WINDOW_OPTIONS, onChange: (value: string) => setCorrelationWindow(Number(value)) },
        { id: "correlation", kind: "toggle", label: "Corr", value: showCorrelation, defaultValue: true, onChange: setShowCorrelation },
        { id: "regression", kind: "toggle", label: "Fit", value: showRegression, defaultValue: true, onChange: setShowRegression },
      ]}
      // The index base is the unit of the price panel; it gives way first when the bar is full.
      meta={width >= 110 ? "Indexed to 100" : undefined}
    />
  );

  if (!analysis || analysis.aligned.length < 2) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {queryBar}
        <PaneStatusBody loading={loading} error={loading ? null : analysis?.unavailableReason ?? error} subject="relationship history" empty emptyTitle="No overlapping price history." />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {queryBar}
      {statItems.length > 0 ? <StatGrid items={statItems} width={width} /> : null}
      {/* The desktop query bar is a few pixels taller than a row; the chart absorbs
          them rather than clipping the scatter's axis label. */}
      <Box height={layout.chartRows} flexShrink={1} minHeight={0} overflow="hidden">
        <CompositeChart
          series={chartSeries}
          panels={panels}
          width={width}
          height={layout.chartRows}
          cursorDate={cursorDate}
          onCursorDateChange={selectCursorDate}
          navigable={false}
          showTimeAxis
          formatAxisValue={formatAxisValue}
          formatValue={formatLegendValue}
          emptyMessage="No chart data"
        />
      </Box>
      {layout.scatterRows > 0 ? (
        <Box flexDirection="column" height={layout.scatterRows} flexShrink={0}>
          <Box paddingX={1} height={1}><Text fg={colors.textDim}>{`${leftSymbol} returns (%)`}</Text></Box>
          <StaticScatterChartSurface
            points={scatterPoints}
            width={width}
            height={layout.scatterRows - 2}
            regression={stats ? { slope: stats.beta, intercept: stats.alpha, color: REGRESSION_COLOR } : null}
          />
          <Box paddingX={1} height={1}><Text fg={colors.textDim}>{`${rightSymbol} returns (%)`}</Text></Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function createRelationshipPaneTemplate(): PaneTemplateDef {
  return {
    id: "relationship-graph-pane",
    paneId: RELATIONSHIP_GRAPH_PANE_ID,
    label: "Relationship Graph",
    description: "Graph ratio, rolling correlation, and regression between two tickers.",
    keywords: ["relationship", "ratio", "graph", "correlation", "regression", "gr"],
    shortcut: { prefix: "GR", argPlaceholder: "tickers", argKind: "ticker-list" },
    wizard: [
      {
        key: "tickers",
        label: "Relationship Tickers",
        placeholder: "AMD, NVDA",
        body: [`Enter one or two tickers. One ticker compares against ${DEFAULT_RELATIONSHIP_SECOND_SYMBOL}.`],
        type: "text",
      },
    ],
    canCreate: (context, options) => !!relationshipTemplateSymbols(context.activeTicker, options),
    createInstance: (context, options) => {
      const pair = relationshipTemplateSymbols(context.activeTicker, options);
      return pair
        ? {
          title: buildRelationshipGraphPaneTitle(pair),
          binding: { kind: "fixed" as const, symbol: pair[0] },
          placement: "floating" as const,
          settings: {
            symbols: pair,
            symbolsText: formatTickerListInput(pair),
          },
        }
        : null;
    },
  };
}
