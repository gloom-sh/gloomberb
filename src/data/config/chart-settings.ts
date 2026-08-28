import type { ChartResolution, TimeRange } from "../../time-series/range";
import type { LayoutConfig, PaneBinding } from "../../types/config";
import type {
  ChartPanelSpec,
  ChartSeriesSpec,
  ChartSpec,
  ChartStudySpec,
  SeriesPeriod,
  SeriesStyle,
} from "../../time-series/types";
import { CHART_SPEC_VERSION } from "../../time-series/types";
import { getTimeSeriesField } from "../../time-series/field-catalog";
import {
  coerceSeriesTransformForStyle,
  normalizeChartSpec,
  validateChartSpec,
} from "../../time-series/spec";

const CHART_RANGES = new Set<TimeRange>(["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"]);
const CHART_RESOLUTIONS = new Set<ChartResolution>(["auto", "1m", "5m", "15m", "30m", "45m", "1h", "1d", "1wk", "1mo"]);
const PRICE_RENDER_MODES = new Set<SeriesStyle>(["area", "line", "candles", "ohlc", "hlc"]);
const LEGACY_INDICATOR_IDS = new Set<LegacyChartIndicatorId>([
  "volume",
  "sma20",
  "sma50",
  "sma200",
  "ema20",
  "bollinger20",
]);
const LEGACY_GRAPH_PLUGIN_IDS = ["ticker-detail", "ticker-research", "company-research"] as const;
const LEGACY_GRAPH_STATE_KEYS = new Set([
  "period",
  "chartKind",
  "metric",
  "periods",
  "detailPeriod",
  "detailChartKind",
  "detailMetric",
  "selectedIdx",
  "hiddenSeriesIds",
]);

export type LegacyChartIndicatorId =
  | "volume"
  | "sma20"
  | "sma50"
  | "sma200"
  | "ema20"
  | "bollinger20";

export interface LegacyChartIndicatorSelection {
  ids: LegacyChartIndicatorId[];
  /** A stored selection replaced pane indicator configuration in the old UI. */
  explicit: boolean;
}

export interface LegacyChartMigrationContext {
  migrateLegacy?: boolean;
  defaultRenderMode?: SeriesStyle;
  indicatorSelection?: LegacyChartIndicatorSelection;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: Record<string, unknown> | undefined, key: string): boolean {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean))];
}

function symbolList(settings: Record<string, unknown> | undefined, binding: PaneBinding | undefined): string[] {
  const stored = strings(settings?.symbols);
  if (stored.length > 0) return stored;
  if (typeof settings?.symbol === "string" && settings.symbol.trim()) {
    return [settings.symbol.trim().toUpperCase()];
  }
  return binding?.kind === "fixed" && binding.symbol.trim()
    ? [binding.symbol.trim().toUpperCase()]
    : [];
}

function range(value: unknown, fallback: TimeRange): TimeRange {
  return CHART_RANGES.has(value as TimeRange) ? value as TimeRange : fallback;
}

function resolution(value: unknown, fallback: ChartResolution): ChartResolution {
  return CHART_RESOLUTIONS.has(value as ChartResolution) ? value as ChartResolution : fallback;
}

function makeSpec(
  series: ChartSeriesSpec[],
  viewport: ChartSpec["viewport"],
): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    viewport,
    panels: [{ id: "main", height: 1, scale: "linear" }],
    series,
    studies: [],
  };
}

function securitySeries(
  symbol: string,
  index: number,
  options: {
    fieldId: string;
    style: ChartSeriesSpec["style"];
    transform?: ChartSeriesSpec["transform"];
    period?: SeriesPeriod;
    timestampMode?: "available-at" | "period-end";
  },
): ChartSeriesSpec {
  return {
    id: `${symbol.toLowerCase()}-${options.fieldId.replace(/[^a-z0-9]+/gi, "-")}-${index + 1}`,
    source: {
      kind: "security",
      instrument: { symbol },
      fieldId: options.fieldId,
      period: options.period,
      timestampMode: options.timestampMode,
    },
    label: symbol,
    style: options.style,
    transform: options.transform ?? "raw",
    axis: "auto",
    panelId: "main",
    interpolation: options.style === "columns" || options.fieldId.startsWith("market.")
      ? "none"
      : "step-after",
    visible: true,
  };
}

function priceStyle(value: unknown, fallback: SeriesStyle = "area"): SeriesStyle {
  return PRICE_RENDER_MODES.has(value as SeriesStyle) ? value as SeriesStyle : fallback;
}

function parsedChartSpec(value: unknown): ChartSpec | null {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const input = record(decoded);
  if (!input) return null;
  const version = input.version;
  const legacySeries = Array.isArray(input.series) ? input.series : [];
  const legacyIsCapabilityFree = legacySeries.every((entry) => {
    const source = record(entry) ? record(entry.source) : null;
    return source?.kind === "security" || source?.kind === "economic";
  });
  if (version !== CHART_SPEC_VERSION
    && !((version === 1 || version === undefined) && legacyIsCapabilityFree)) return null;
  const spec = normalizeChartSpec(input);
  return validateChartSpec(spec).valid ? spec : null;
}

function panelForStudy(panelId: string): ChartPanelSpec {
  if (panelId === "volume") return { id: panelId, label: "Volume", height: 0.24 };
  if (panelId === "rsi" || panelId === "macd") {
    return { id: panelId, label: panelId.toUpperCase(), height: 0.28 };
  }
  return { id: panelId };
}

function reconcilePanels(spec: ChartSpec, studies: readonly ChartStudySpec[]): ChartPanelSpec[] {
  const requiredIds = new Set([
    "main",
    ...spec.series.map((series) => series.panelId),
    ...studies.map((study) => study.panelId),
  ]);
  const retained = spec.panels.filter((panel) => requiredIds.has(panel.id));
  const retainedIds = new Set(retained.map((panel) => panel.id));
  return [
    ...retained,
    ...[...requiredIds].filter((id) => !retainedIds.has(id)).map(panelForStudy),
  ];
}

function indicatorStudy(
  id: string,
  inputSeriesId: string,
  kind: ChartStudySpec["kind"],
  parameters: Record<string, number>,
  panelId = "main",
): ChartStudySpec {
  return {
    id,
    kind,
    inputSeriesIds: [inputSeriesId],
    parameters,
    panelId,
    axis: "auto",
  };
}

function studiesForSelection(
  ids: readonly LegacyChartIndicatorId[],
  inputSeriesId: string,
): ChartStudySpec[] {
  const selected = new Set(ids);
  return [
    ...(selected.has("volume")
      ? [indicatorStudy(`builtin:volume:${inputSeriesId}`, inputSeriesId, "volume", {}, "volume")]
      : []),
    ...(selected.has("sma20")
      ? [indicatorStudy(`builtin:sma20:${inputSeriesId}`, inputSeriesId, "sma", { period: 20 })]
      : []),
    ...(selected.has("sma50")
      ? [indicatorStudy(`builtin:sma50:${inputSeriesId}`, inputSeriesId, "sma", { period: 50 })]
      : []),
    ...(selected.has("sma200")
      ? [indicatorStudy(`builtin:sma200:${inputSeriesId}`, inputSeriesId, "sma", { period: 200 })]
      : []),
    ...(selected.has("ema20")
      ? [indicatorStudy(`builtin:ema20:${inputSeriesId}`, inputSeriesId, "ema", { period: 20 })]
      : []),
    ...(selected.has("bollinger20")
      ? [indicatorStudy(`builtin:bollinger20:${inputSeriesId}`, inputSeriesId, "bollinger", { period: 20, stdDev: 2 })]
      : []),
  ];
}

function positiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is number => (
    typeof entry === "number" && Number.isFinite(entry) && entry > 0
  )).map((entry) => Math.floor(entry)))];
}

function studiesForIndicatorConfig(value: unknown, inputSeriesId: string): ChartStudySpec[] {
  const config = record(value);
  if (!config) return [];
  const studies: ChartStudySpec[] = [];
  for (const period of positiveIntegers(config.sma)) {
    const builtin = period === 20 || period === 50 || period === 200;
    studies.push(indicatorStudy(
      builtin ? `builtin:sma${period}:${inputSeriesId}` : `migrated:sma:${period}:${inputSeriesId}`,
      inputSeriesId,
      "sma",
      { period },
    ));
  }
  for (const period of positiveIntegers(config.ema)) {
    studies.push(indicatorStudy(
      period === 20 ? `builtin:ema20:${inputSeriesId}` : `migrated:ema:${period}:${inputSeriesId}`,
      inputSeriesId,
      "ema",
      { period },
    ));
  }
  const bollinger = record(config.bollinger);
  if (typeof bollinger?.period === "number" && bollinger.period > 0) {
    const period = Math.floor(bollinger.period);
    const stdDev = typeof bollinger.stdDev === "number" && bollinger.stdDev > 0 ? bollinger.stdDev : 2;
    studies.push(indicatorStudy(
      period === 20 && stdDev === 2
        ? `builtin:bollinger20:${inputSeriesId}`
        : `migrated:bollinger:${period}:${inputSeriesId}`,
      inputSeriesId,
      "bollinger",
      { period, stdDev },
    ));
  }
  if (typeof config.rsi === "number" && config.rsi > 0) {
    const period = Math.floor(config.rsi);
    studies.push(indicatorStudy(
      period === 14 ? `builtin:rsi14:${inputSeriesId}` : `migrated:rsi:${period}:${inputSeriesId}`,
      inputSeriesId,
      "rsi",
      { period },
      "rsi",
    ));
  }
  const macd = record(config.macd);
  if (
    typeof macd?.fast === "number" && macd.fast > 0
    && typeof macd.slow === "number" && macd.slow > 0
    && typeof macd.signal === "number" && macd.signal > 0
  ) {
    const parameters = {
      fast: Math.floor(macd.fast),
      slow: Math.floor(macd.slow),
      signal: Math.floor(macd.signal),
    };
    const standard = parameters.fast === 12 && parameters.slow === 26 && parameters.signal === 9;
    studies.push(indicatorStudy(
      standard ? `builtin:macd:${inputSeriesId}` : `migrated:macd:${inputSeriesId}`,
      inputSeriesId,
      "macd",
      parameters,
      "macd",
    ));
  }
  return studies;
}

function applyLegacyIndicators(
  spec: ChartSpec,
  selection: LegacyChartIndicatorSelection | undefined,
  indicatorConfig: unknown,
): ChartSpec {
  const input = spec.series.find((series) => (
    series.source.kind === "security"
    && (series.source.fieldId === "market.ohlcv" || series.source.fieldId === "market.close")
  ));
  if (!input || (!selection && !record(indicatorConfig))) return spec;

  const selectedStudies = selection ? studiesForSelection(selection.ids, input.id) : [];
  const configuredStudies = selection?.explicit ? [] : studiesForIndicatorConfig(indicatorConfig, input.id);
  const migratedStudies = [...selectedStudies, ...configuredStudies].filter((study, index, all) => (
    all.findIndex((candidate) => candidate.id === study.id) === index
  ));
  const retainedStudies = spec.studies.filter((study) => (
    !study.id.startsWith("builtin:") && !study.id.startsWith("migrated:")
  ));
  const studies = [...retainedStudies, ...migratedStudies];
  return { ...spec, studies, panels: reconcilePanels(spec, studies) };
}

function legacyPriceSpec(
  symbol: string,
  settings: Record<string, unknown> | undefined,
  context: LegacyChartMigrationContext,
): ChartSpec {
  const style = priceStyle(settings?.chartRenderMode, priceStyle(context.defaultRenderMode, "area"));
  const transform = coerceSeriesTransformForStyle(
    style,
    settings?.chartAxisMode === "percent" ? "percent" : "raw",
  );
  const spec = makeSpec(
    [securitySeries(symbol, 0, { fieldId: "market.ohlcv", style, transform })],
    {
      range: range(settings?.chartRangePreset, "5Y"),
      resolution: resolution(settings?.chartResolution, "auto"),
    },
  );
  return applyLegacyIndicators(spec, context.indicatorSelection, settings?.indicators);
}

function hasLegacyPriceSettings(settings: Record<string, unknown> | undefined): boolean {
  return ["chartAxisMode", "chartRangePreset", "chartResolution", "chartRenderMode", "indicators"]
    .some((key) => hasOwn(settings, key));
}

function stripKeys(
  settings: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const retained = { ...(settings ?? {}) };
  for (const key of keys) delete retained[key];
  return retained;
}

export function migrateChartPaneSettings(
  paneId: string,
  binding: PaneBinding | undefined,
  settings: Record<string, unknown> | undefined,
  context: LegacyChartMigrationContext = {},
): Record<string, unknown> | undefined {
  if (!context.migrateLegacy) return settings;
  if (paneId === "chart-composer") {
    const retained = stripKeys(settings, [
      "chartAxisMode",
      "chartRangePreset",
      "chartResolution",
      "chartRenderMode",
      "indicators",
      "axisMode",
      "rangePreset",
      "symbols",
      "symbolsText",
      "symbol",
      "chartKind",
      "metric",
      "period",
      "periods",
    ]);
    const spec = parsedChartSpec(retained.chartSpec);
    if (spec && context.indicatorSelection) {
      retained.chartSpec = applyLegacyIndicators(spec, context.indicatorSelection, undefined);
    }
    return Object.keys(retained).length > 0 ? retained : undefined;
  }
  const symbols = symbolList(settings, binding);

  if (paneId === "ticker-research" || paneId === "ticker-detail") {
    const retained = stripKeys(settings, [
      "chartAxisMode",
      "chartRangePreset",
      "chartResolution",
      "chartRenderMode",
      "indicators",
      "detailPeriod",
      "detailChartKind",
      "detailMetric",
    ]);
    if (retained.lockedTabId === "fundamental-graphs") retained.lockedTabId = "chart";
    const existingSpec = parsedChartSpec(retained.chartSpec);
    if (existingSpec && context.indicatorSelection) {
      retained.chartSpec = applyLegacyIndicators(existingSpec, context.indicatorSelection, undefined);
    } else if (
      !existingSpec
      && symbols[0]
      && (hasLegacyPriceSettings(settings) || context.indicatorSelection?.explicit === true)
    ) {
      retained.chartSpec = legacyPriceSpec(symbols[0], settings, context);
    }
    return Object.keys(retained).length > 0 ? retained : undefined;
  }

  if (paneId === "ticker-chart") {
    if (symbols.length === 0) return undefined;
    return {
      chartSpec: legacyPriceSpec(symbols[0]!, settings, context),
    };
  }

  if (paneId === "comparison-chart") {
    if (symbols.length === 0) return undefined;
    const transform = settings?.axisMode === "price" ? "raw" : "percent";
    const style = priceStyle(context.defaultRenderMode, "area") === "line" ? "line" : "area";
    return {
      chartSpec: makeSpec(
        symbols.map((symbol, index) => securitySeries(symbol, index, {
          fieldId: "market.close",
          style,
          transform,
        })),
        {
          range: range(settings?.rangePreset, "1Y"),
          resolution: resolution(settings?.chartResolution, "1d"),
        },
      ),
    };
  }

  if (paneId === "fundamental-graph") {
    if (symbols.length === 0) return undefined;
    const valuation = settings?.chartKind === "valuation";
    const metric = typeof settings?.metric === "string"
      ? settings.metric
      : valuation ? "priceSales" : "totalRevenue";
    const period: SeriesPeriod = settings?.period === "quarterly" ? "quarterly" : "annual";
    return {
      chartSpec: makeSpec(
        symbols.map((symbol, index) => securitySeries(symbol, index, {
          fieldId: `${valuation ? "valuation" : "fundamental"}.${metric}`,
          style: valuation ? "line" : "columns",
          period,
          timestampMode: valuation ? "available-at" : "period-end",
        })),
        {
          range: "ALL",
          resolution: "auto",
          maxPoints: typeof settings?.periods === "number" && Number.isFinite(settings.periods)
            ? Math.max(1, Math.min(40, Math.floor(settings.periods)))
            : undefined,
        },
      ),
    };
  }

  return settings;
}

function normalizedLegacyIndicatorIds(value: unknown): LegacyChartIndicatorId[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((entry): entry is LegacyChartIndicatorId => (
    typeof entry === "string" && LEGACY_INDICATOR_IDS.has(entry as LegacyChartIndicatorId)
  )));
  return ["volume", "sma20", "sma50", "sma200", "ema20", "bollinger20"]
    .filter((id): id is LegacyChartIndicatorId => selected.has(id as LegacyChartIndicatorId));
}

export function extractLegacyChartIndicatorSelection(
  pluginConfig: Record<string, Record<string, unknown>>,
  includeImplicitDefault: boolean,
): LegacyChartIndicatorSelection | undefined {
  const state = pluginConfig["ticker-research"]
    ?? pluginConfig["ticker-detail"]
    ?? pluginConfig["company-research"];
  const hasStoredSelection = !!state && hasOwn(state, "chartIndicators");
  if (!hasStoredSelection && !includeImplicitDefault) return undefined;

  if (!Array.isArray(state?.chartIndicators)) {
    return { ids: ["volume"], explicit: false };
  }
  const ids = normalizedLegacyIndicatorIds(state.chartIndicators);
  return state.chartIndicatorsVersion === 2
    ? { ids, explicit: true }
    : { ids: normalizedLegacyIndicatorIds(["volume", ...ids]), explicit: true };
}

export function stripLegacyChartPluginConfig(
  pluginConfig: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [pluginId, state] of Object.entries(pluginConfig)) {
    if (pluginId !== "ticker-research" && pluginId !== "ticker-detail" && pluginId !== "company-research") {
      result[pluginId] = { ...state };
      continue;
    }
    const retained = { ...state };
    delete retained.chartIndicators;
    delete retained.chartIndicatorsVersion;
    if (Object.keys(retained).length > 0) result[pluginId] = retained;
  }
  return result;
}

function chartSymbols(spec: ChartSpec | null, binding: PaneBinding | undefined, paneState: Record<string, unknown>): string[] {
  const stored = spec?.series.flatMap((series) => (
    series.source.kind === "security" ? [series.source.instrument.symbol] : []
  )) ?? [];
  if (stored.length > 0) return [...new Set(stored)];
  if (binding?.kind === "fixed" && binding.symbol.trim()) return [binding.symbol.trim().toUpperCase()];
  return typeof paneState.cursorSymbol === "string" && paneState.cursorSymbol.trim()
    ? [paneState.cursorSymbol.trim().toUpperCase()]
    : [];
}

function legacyGraphField(
  kindValue: unknown,
  metricValue: unknown,
  fallbackSpec?: ChartSpec | null,
): { fieldId: string; valuation: boolean } {
  const kind = kindValue === "valuation" ? "valuation" : "fundamental";
  if (typeof metricValue === "string") {
    const fundamentalId = `fundamental.${metricValue}`;
    const valuationId = `valuation.${metricValue}`;
    if (getTimeSeriesField(fundamentalId)) return { fieldId: fundamentalId, valuation: false };
    if (getTimeSeriesField(valuationId)) return { fieldId: valuationId, valuation: true };
  }
  const fallbackFieldId = fallbackSpec?.series.find((series) => (
    series.source.kind === "security"
    && (series.source.fieldId.startsWith("fundamental.") || series.source.fieldId.startsWith("valuation."))
  ))?.source;
  if (fallbackFieldId?.kind === "security") {
    return {
      fieldId: fallbackFieldId.fieldId,
      valuation: fallbackFieldId.fieldId.startsWith("valuation."),
    };
  }
  return kind === "valuation"
    ? { fieldId: "valuation.priceSales", valuation: true }
    : { fieldId: "fundamental.totalRevenue", valuation: false };
}

function legacyPeriod(value: unknown, fallbackSpec?: ChartSpec | null): SeriesPeriod {
  if (value === "annual" || value === "quarterly") return value;
  const fallback = fallbackSpec?.series.find((series) => series.source.kind === "security")?.source;
  return fallback?.kind === "security" && (fallback.period === "annual" || fallback.period === "quarterly")
    ? fallback.period
    : "quarterly";
}

function periodLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(40, Math.floor(value)))
    : undefined;
}

function buildLegacyGraphSpec(
  symbols: readonly string[],
  state: Record<string, unknown>,
  detail: boolean,
  fallbackSpec?: ChartSpec | null,
): ChartSpec {
  const kindKey = detail ? "detailChartKind" : "chartKind";
  const metricKey = detail ? "detailMetric" : "metric";
  const periodKey = detail ? "detailPeriod" : "period";
  const field = legacyGraphField(state[kindKey], state[metricKey], fallbackSpec);
  const period = legacyPeriod(state[periodKey], fallbackSpec);
  const hidden = new Set(strings(state.hiddenSeriesIds));
  const series = symbols.map((symbol, index) => ({
    ...securitySeries(symbol, index, {
      fieldId: field.fieldId,
      style: field.valuation ? "line" : "columns",
      period,
      timestampMode: field.valuation ? "available-at" : "period-end",
    }),
    visible: !hidden.has(symbol),
  }));
  return makeSpec(series, {
    range: "ALL",
    resolution: "auto",
    maxPoints: detail
      ? undefined
      : hasOwn(state, "periods") ? periodLimit(state.periods) : fallbackSpec?.viewport.maxPoints,
  });
}

function mergedLegacyGraphState(paneState: Record<string, unknown>): Record<string, unknown> {
  const pluginState = record(paneState.pluginState);
  const merged: Record<string, unknown> = {};
  for (const pluginId of LEGACY_GRAPH_PLUGIN_IDS) {
    Object.assign(merged, record(pluginState?.[pluginId]) ?? {});
  }
  return merged;
}

function originalPaneSettings(value: unknown, instanceId: string): Record<string, unknown> | null {
  const layout = record(value);
  if (!Array.isArray(layout?.instances)) return null;
  const instance = layout.instances.find((entry) => record(entry)?.instanceId === instanceId);
  return record(record(instance)?.settings);
}

function stripLegacyGraphPaneState(
  paneState: Record<string, unknown>,
  migrateActiveTab: boolean,
): Record<string, unknown> {
  const retained = { ...paneState };
  if (migrateActiveTab && retained.activeTabId === "fundamental-graphs") retained.activeTabId = "chart";
  const pluginState = record(retained.pluginState);
  if (!pluginState) return retained;

  const nextPluginState: Record<string, unknown> = { ...pluginState };
  for (const pluginId of LEGACY_GRAPH_PLUGIN_IDS) {
    const state = record(nextPluginState[pluginId]);
    if (!state) continue;
    const nextState = Object.fromEntries(
      Object.entries(state).filter(([key]) => !LEGACY_GRAPH_STATE_KEYS.has(key)),
    );
    if (Object.keys(nextState).length > 0) nextPluginState[pluginId] = nextState;
    else delete nextPluginState[pluginId];
  }
  if (Object.keys(nextPluginState).length > 0) retained.pluginState = nextPluginState;
  else delete retained.pluginState;
  return retained;
}

/**
 * Fold chart-owned runtime state into the unified pane spec. Saved layout state
 * is the only old persistence layer that carried graph metric/period choices.
 */
export function migrateLegacyChartSavedPaneState(
  layout: LayoutConfig,
  paneState: Record<string, Record<string, unknown>> | undefined,
  originalLayout?: unknown,
): { layout: LayoutConfig; paneState: Record<string, Record<string, unknown>> | undefined } {
  if (!paneState) return { layout, paneState };
  let nextLayout = layout;
  let layoutChanged = false;
  const nextPaneState: Record<string, Record<string, unknown>> = {};

  for (const [instanceId, state] of Object.entries(paneState)) {
    const instanceIndex = layout.instances.findIndex((instance) => instance.instanceId === instanceId);
    const instance = layout.instances[instanceIndex];
    if (!instance || (instance.paneId !== "chart-composer" && instance.paneId !== "ticker-research")) {
      nextPaneState[instanceId] = state;
      continue;
    }

    const legacyState = mergedLegacyGraphState(state);
    const hasAnyLegacyGraphState = [...LEGACY_GRAPH_STATE_KEYS]
      .some((key) => hasOwn(legacyState, key));
    const hasStandaloneState = ["period", "chartKind", "metric", "periods", "hiddenSeriesIds"]
      .some((key) => hasOwn(legacyState, key));
    const hasDetailState = ["detailPeriod", "detailChartKind", "detailMetric"]
      .some((key) => hasOwn(legacyState, key));
    const originalSettings = originalPaneSettings(originalLayout, instanceId);
    const graphWasActive = state.activeTabId === "fundamental-graphs"
      || originalSettings?.lockedTabId === "fundamental-graphs";
    const useStandaloneState = instance.paneId === "chart-composer" && hasStandaloneState;
    const useDetailState = instance.paneId === "ticker-research" && graphWasActive;
    const currentSpec = parsedChartSpec(instance.settings?.chartSpec);
    const symbols = chartSymbols(currentSpec, instance.binding, state);

    if ((useStandaloneState || useDetailState) && symbols.length > 0) {
      const migratedSpec = buildLegacyGraphSpec(symbols, legacyState, useDetailState, currentSpec);
      if (!layoutChanged) {
        nextLayout = {
          ...layout,
          instances: [...layout.instances],
          floating: [...layout.floating],
          detached: [...layout.detached],
        };
        layoutChanged = true;
      }
      nextLayout.instances[instanceIndex] = {
        ...instance,
        settings: { ...(instance.settings ?? {}), chartSpec: migratedSpec },
      };
    }

    const shouldStripGraphState = hasAnyLegacyGraphState || graphWasActive;
    nextPaneState[instanceId] = shouldStripGraphState
      ? stripLegacyGraphPaneState(state, true)
      : state.activeTabId === "fundamental-graphs"
        ? { ...state, activeTabId: "chart" }
        : state;
  }

  return {
    layout: nextLayout,
    paneState: Object.keys(nextPaneState).length > 0 ? nextPaneState : undefined,
  };
}
