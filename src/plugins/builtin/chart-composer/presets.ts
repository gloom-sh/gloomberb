import {
  CHART_SPEC_VERSION,
  type ChartPanelSpec,
  type ChartSeriesSpec,
  type ChartSpec,
  type ChartStudyKind,
  type ChartStudySpec,
  type SeriesAxis,
  type SeriesPeriod,
  type SeriesStyle,
  type SeriesTimestampMode,
  type SeriesTransform,
} from "../../../time-series/types";
import type { ChartResolution, TimeRange } from "../../../components/chart/core/types";
import {
  canonicalTimeSeriesFieldId,
  getTimeSeriesField,
  isFundamentalFieldId,
  listTimeSeriesFields,
} from "../../../time-series/field-catalog";
import {
  coerceSeriesInterpolationForStyle,
  coerceSeriesTransformForStyle,
  isOhlcSeriesStyle,
} from "../../../time-series/spec";
import {
  CANONICAL_EXCHANGE_ALIASES,
  canonicalExchange,
  publicTickerKey,
} from "../../../utils/exchanges";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";

const CHART_FIELD_IDS = {
  price: "market.ohlcv",
  close: "market.close",
  volume: "market.volume",
  revenue: "fundamental.totalRevenue",
  grossProfit: "fundamental.grossProfit",
  operatingIncome: "fundamental.operatingIncome",
  netIncome: "fundamental.netIncome",
  freeCashFlow: "fundamental.freeCashFlow",
  eps: "fundamental.eps",
  trailingPE: "valuation.trailingPE",
  forwardPE: "valuation.forwardPE",
  evEbitda: "valuation.evEbitda",
} as const;

export type ParsedSeriesExpression =
  | { kind: "security"; symbol: string; exchange?: string; fieldId: string; label?: string }
  | { kind: "economic"; provider: "fred"; seriesId: string; label?: string };

function normalizeBaseSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.^_-]{0,31}$/.test(symbol) ? symbol : null;
}

function normalizeInstrument(
  value: string,
  allowUnknownExchange = false,
): { symbol: string; exchange?: string } | null {
  const parts = value.trim().split(":");
  if (parts.length === 1) {
    const symbol = normalizeBaseSymbol(parts[0]!);
    return symbol ? { symbol } : null;
  }
  if (parts.length !== 2) return null;
  const symbol = normalizeBaseSymbol(parts[0]!);
  const exchangeToken = parts[1]!.trim().toUpperCase();
  const knownExchange = Object.prototype.hasOwnProperty.call(CANONICAL_EXCHANGE_ALIASES, exchangeToken);
  if (!symbol || !/^[A-Z0-9._-]{1,24}$/.test(exchangeToken) || (!knownExchange && !allowUnknownExchange)) {
    return null;
  }
  return { symbol, exchange: canonicalExchange(exchangeToken) };
}

export function resolveChartFieldAlias(value: string | undefined): string {
  if (!value?.trim()) return CHART_FIELD_IDS.price;
  const trimmed = value.trim();
  const canonical = canonicalTimeSeriesFieldId(trimmed);
  if (getTimeSeriesField(canonical)) return canonical;
  const searchable = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = listTimeSeriesFields().find((field) => (
    field.id.toLowerCase().replace(/[^a-z0-9]/g, "") === searchable
    || field.label.toLowerCase().replace(/[^a-z0-9]/g, "") === searchable
    || field.shortLabel.toLowerCase().replace(/[^a-z0-9]/g, "") === searchable
  ));
  return match?.id ?? canonical;
}

export function parseSeriesExpression(value: string): ParsedSeriesExpression | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts[0]?.trim().toUpperCase() === "FRED") {
    const seriesId = parts.length === 2 ? parts[1]?.trim().toUpperCase() ?? "" : "";
    return /^[A-Z0-9._-]{1,80}$/.test(seriesId)
      ? { kind: "economic", provider: "fred", seriesId }
      : null;
  }

  let instrument: { symbol: string; exchange?: string } | null = null;
  let fieldId: string = CHART_FIELD_IDS.price;
  if (parts.length === 1) {
    instrument = normalizeInstrument(trimmed);
  } else if (parts.length === 2) {
    const candidateFieldId = resolveChartFieldAlias(parts[1]);
    if (getTimeSeriesField(candidateFieldId)) {
      instrument = normalizeInstrument(parts[0]!);
      fieldId = candidateFieldId;
    } else {
      // A known public exchange suffix is unambiguously a qualified ticker.
      instrument = normalizeInstrument(trimmed);
    }
  } else if (parts.length === 3) {
    const candidateFieldId = resolveChartFieldAlias(parts[2]);
    if (getTimeSeriesField(candidateFieldId)) {
      instrument = normalizeInstrument(`${parts[0]}:${parts[1]}`, true);
      fieldId = candidateFieldId;
    }
  }
  if (!instrument) return null;
  if (!getTimeSeriesField(fieldId)) return null;
  return { kind: "security", ...instrument, fieldId };
}

export function parseChartExpression(value: string): ParsedSeriesExpression[] {
  if (!value.trim()) return [];

  const legs = value.split(/[;,\n]/);
  if (legs.length > MAX_CHART_COMPOSER_SERIES) {
    throw new Error(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
  }

  return legs.map((leg) => {
    const parsed = parseSeriesExpression(leg);
    if (parsed) return parsed;
    const display = leg.trim() || "empty series";
    throw new Error(
      `Invalid chart series "${display}". Use SYMBOL, SYMBOL:field, or FRED:series, for example AAPL:price or FRED:CPIAUCSL.`,
    );
  });
}

export function formatSeriesExpression(series: ChartSeriesSpec): string {
  if (series.source.kind === "economic") return `FRED:${series.source.seriesId}`;
  return `${publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)}:${series.source.fieldId}`;
}

export function chartSeriesLabel(series: ChartSeriesSpec): string {
  if (series.label?.trim()) return series.label.trim();
  if (series.source.kind === "economic") return `FRED ${series.source.seriesId}`;
  const instrument = publicTickerKey(
    series.source.instrument.symbol,
    series.source.instrument.exchange,
  );
  const field = getTimeSeriesField(series.source.fieldId);
  return `${instrument} ${field?.shortLabel ?? series.source.fieldId.split(".").at(-1) ?? "Series"}`;
}

export function getCompatibleSeriesStyles(fieldId: string): SeriesStyle[] {
  return getTimeSeriesField(fieldId)?.styles ?? ["line", "area", "step", "columns", "points"];
}

export function getCompatibleSeriesTransforms(fieldId: string): SeriesTransform[] {
  return getTimeSeriesField(fieldId)?.transforms ?? ["raw", "percent", "index100", "yoy", "qoq", "log"];
}

export function defaultFinancialTimestampMode(fieldId: string): SeriesTimestampMode | null {
  const canonical = canonicalTimeSeriesFieldId(fieldId);
  if (canonical.startsWith("fundamental.")) return "period-end";
  if (canonical.startsWith("valuation.")) return "available-at";
  return null;
}

export function applySeriesTimestampMode(
  series: ChartSeriesSpec,
  timestampMode: SeriesTimestampMode,
): ChartSeriesSpec {
  if (series.source.kind !== "security" || !isFundamentalFieldId(series.source.fieldId)) {
    return series;
  }
  return {
    ...series,
    source: { ...series.source, timestampMode },
  };
}

/** Apply visual invariants without changing the series' authored time basis. */
export function applySeriesStyle(series: ChartSeriesSpec, style: SeriesStyle): ChartSeriesSpec {
  return {
    ...series,
    style,
    transform: coerceSeriesTransformForStyle(style, series.transform),
    interpolation: coerceSeriesInterpolationForStyle(style),
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "series";
}

function defaultSeriesPresentation(fieldId: string): {
  style: SeriesStyle;
  transform: SeriesTransform;
  axis: SeriesAxis;
  period: SeriesPeriod;
  panelId: string;
} {
  const field = getTimeSeriesField(fieldId);
  return {
    style: field?.defaultStyle ?? "line",
    transform: "raw",
    axis: "auto",
    period: field?.nativeFrequency === "daily" ? "auto" : field?.nativeFrequency ?? "auto",
    panelId: fieldId === CHART_FIELD_IDS.volume ? "volume" : "main",
  };
}

export function buildSeriesSpec(
  expression: ParsedSeriesExpression,
  index: number,
  overrides: Partial<Omit<ChartSeriesSpec, "id" | "source">> = {},
): ChartSeriesSpec {
  if (expression.kind === "economic") {
    const style = overrides.style ?? "step";
    return {
      id: `fred-${slug(expression.seriesId)}-${index + 1}`,
      source: { kind: "economic", provider: "fred", seriesId: expression.seriesId },
      ...(expression.label ? { label: expression.label } : {}),
      transform: "raw",
      axis: "auto",
      panelId: "main",
      ...overrides,
      style,
      interpolation: coerceSeriesInterpolationForStyle(style),
    };
  }
  const presentation = defaultSeriesPresentation(expression.fieldId);
  const style = overrides.style ?? presentation.style;
  const timestampMode = defaultFinancialTimestampMode(expression.fieldId);
  return {
    id: `${slug(expression.symbol)}-${slug(expression.fieldId)}-${index + 1}`,
    source: {
      kind: "security",
      instrument: {
        symbol: expression.symbol,
        ...(expression.exchange ? { exchange: expression.exchange } : {}),
      },
      fieldId: expression.fieldId,
      period: presentation.period,
      ...(timestampMode ? { timestampMode } : {}),
    },
    ...(expression.label ? { label: expression.label } : {}),
    transform: presentation.transform,
    axis: presentation.axis,
    panelId: presentation.panelId,
    ...overrides,
    style,
    interpolation: coerceSeriesInterpolationForStyle(style),
  };
}

function uniqueSeriesId(series: readonly ChartSeriesSpec[], preferredId: string): string {
  if (!series.some((entry) => entry.id === preferredId)) return preferredId;
  let suffix = 2;
  while (series.some((entry) => entry.id === `${preferredId}-${suffix}`)) suffix += 1;
  return `${preferredId}-${suffix}`;
}

function coerceOhlcPanelCollision(
  series: ChartSeriesSpec,
  existing: readonly ChartSeriesSpec[],
): ChartSeriesSpec {
  return isOhlcSeriesStyle(series.style)
    && existing.some((entry) => (
      entry.panelId === series.panelId && isOhlcSeriesStyle(entry.style)
    ))
    ? applySeriesStyle(series, "line")
    : series;
}

function isFinancialSeries(series: ChartSeriesSpec): boolean {
  return series.source.kind === "security" && isFundamentalFieldId(series.source.fieldId);
}

function isMarketPriceSeries(series: ChartSeriesSpec): boolean {
  return series.source.kind === "security"
    && getTimeSeriesField(series.source.fieldId)?.unitGroup === "price";
}

function effectiveSeriesUnitGroup(series: ChartSeriesSpec): string {
  if (series.transform === "percent" || series.transform === "yoy" || series.transform === "qoq") {
    return "percent";
  }
  if (series.transform === "index100") return "index";
  return series.source.kind === "economic"
    ? `economic:${series.source.seriesId}`
    : getTimeSeriesField(series.source.fieldId)?.unitGroup ?? series.source.fieldId;
}

function nextGeneratedPanelId(
  spec: Pick<ChartSpec, "panels" | "series" | "studies">,
  prefix = "panel",
): string {
  const used = new Set([
    ...spec.panels.map((panel) => panel.id),
    ...spec.series.map((series) => series.panelId),
    ...spec.studies.map((study) => study.panelId),
  ]);
  let index = 2;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function availableGenericPanelId(
  spec: ChartSpec,
  candidate: ChartSeriesSpec,
): string {
  const candidateGroup = effectiveSeriesUnitGroup(candidate);
  const canFit = (panelId: string) => {
    if (spec.studies.some((study) => study.panelId === panelId && panelId !== "main")) {
      return false;
    }
    const groups = new Set(
      spec.series
        .filter((series) => series.panelId === panelId)
        .map(effectiveSeriesUnitGroup),
    );
    return groups.has(candidateGroup) || groups.size < 2;
  };
  if (canFit(candidate.panelId)) return candidate.panelId;
  const generated = spec.panels
    .map((panel) => panel.id)
    .filter((panelId) => /^panel-\d+$/.test(panelId))
    .find(canFit);
  return generated ?? nextGeneratedPanelId(spec);
}

function availableFinancialPanelId(
  spec: ChartSpec,
  candidate: ChartSeriesSpec,
): string {
  const { series, studies } = spec;
  const candidateGroup = effectiveSeriesUnitGroup(candidate);
  const existingPanelIds = [
    ...new Set(
      series
        .filter(isFinancialSeries)
        .map((entry) => entry.panelId)
        .filter((id) => id !== "main"),
    ),
  ];
  for (const panelId of existingPanelIds) {
    if (studies.some((study) => study.panelId === panelId)) continue;
    const occupants = series.filter((entry) => entry.panelId === panelId);
    const groups = new Set(occupants.filter(isFinancialSeries).map(effectiveSeriesUnitGroup));
    if (occupants.every(isFinancialSeries) && (groups.has(candidateGroup) || groups.size < 2)) {
      return panelId;
    }
  }

  let suffix = 1;
  while (true) {
    const panelId = suffix === 1 ? "fundamentals" : `fundamentals-${suffix}`;
    const occupants = series.filter((entry) => entry.panelId === panelId);
    const usedByStudy = studies.some((study) => study.panelId === panelId);
    if (occupants.length === 0 && !usedByStudy) return panelId;
    if (!usedByStudy && occupants.every(isFinancialSeries)) {
      const groups = new Set(occupants.map(effectiveSeriesUnitGroup));
      if (groups.has(candidateGroup) || groups.size < 2) return panelId;
    }
    suffix += 1;
  }
}

function placeAppendedSeriesByDefault(
  series: ChartSeriesSpec,
  spec: ChartSpec,
): ChartSeriesSpec {
  if (series.panelId !== "main") return series;
  if (isFinancialSeries(series) && spec.series.some(isMarketPriceSeries)) {
    return applySeriesTimestampMode({
      ...series,
      panelId: availableFinancialPanelId(spec, series),
    }, "available-at");
  }
  const sharesPanelWithFinancial = isMarketPriceSeries(series)
    && spec.series.some((entry) => (
      entry.panelId === series.panelId && isFinancialSeries(entry)
    ));
  return {
    ...series,
    panelId: sharesPanelWithFinancial
      ? nextGeneratedPanelId(spec)
      : availableGenericPanelId(spec, series),
  };
}

function ensureRequiredPanels(
  existing: readonly ChartPanelSpec[],
  series: readonly ChartSeriesSpec[],
  studies: readonly ChartStudySpec[],
): ChartPanelSpec[] {
  const known = new Set(existing.map((panel) => panel.id));
  return [
    ...existing,
    ...panelsForSeries(series, studies).filter((panel) => !known.has(panel.id)),
  ];
}

export function appendChartSeries(
  spec: ChartSpec,
  expression: ParsedSeriesExpression,
): { spec: ChartSpec; series: ChartSeriesSpec } {
  const built = coerceOhlcPanelCollision(
    placeAppendedSeriesByDefault(
      buildSeriesSpec(expression, spec.series.length),
      spec,
    ),
    spec.series,
  );
  const series = {
    ...built,
    id: uniqueSeriesId(spec.series, built.id),
  };
  const nextSeries = [...spec.series, series];
  return {
    series,
    spec: {
      ...spec,
      series: nextSeries,
      panels: ensureRequiredPanels(spec.panels, nextSeries, spec.studies),
    },
  };
}

function panelsForSeries(series: readonly ChartSeriesSpec[], studies: readonly ChartStudySpec[] = []): ChartPanelSpec[] {
  const panelIds = new Set(["main", ...series.map((entry) => entry.panelId), ...studies.map((entry) => entry.panelId)]);
  return [...panelIds].map((id) => ({
    id,
    ...(id === "volume" ? { label: "Volume", height: 0.24 } : {}),
    ...(id === "fundamentals" || /^fundamentals-\d+$/.test(id)
      ? { label: id === "fundamentals" ? "Fundamentals" : `Fundamentals ${id.slice("fundamentals-".length)}`, height: 0.35 }
      : {}),
    ...(id === "rsi" || id === "macd" ? { label: id.toUpperCase(), height: 0.28 } : {}),
    ...(id === "formula" ? { label: "Formula", height: 0.3 } : {}),
    ...(id === "correlation" ? { label: "Correlation", height: 0.3 } : {}),
    ...(/^panel-\d+$/.test(id) ? { label: `Panel ${id.slice("panel-".length)}`, height: 0.35 } : {}),
  }));
}

/** Keep arbitrary sources legible when one panel would require more than two axes. */
function buildCustomSeries(expressions: readonly ParsedSeriesExpression[]): ChartSeriesSpec[] {
  const parsedSeries = expressions.map((expression, index) => buildSeriesSpec(expression, index));
  const mixedPriceAndFinancial = parsedSeries.some(isMarketPriceSeries)
    && parsedSeries.some(isFinancialSeries);
  const reservedPanelIds = new Set([
    "main",
    ...(mixedPriceAndFinancial ? ["fundamentals"] : []),
    ...parsedSeries.filter((series) => series.panelId !== "main").map((series) => series.panelId),
  ]);
  const panelGroups: Array<{ id: string; scope: string; groups: Set<string> }> = [];
  const builtSeries: ChartSeriesSpec[] = [];
  const nextPanelId = (prefix: "panel" | "fundamentals") => {
    let index = 2;
    while (reservedPanelIds.has(`${prefix}-${index}`)) index += 1;
    const id = `${prefix}-${index}`;
    reservedPanelIds.add(id);
    return id;
  };
  const allocatePanel = (scope: string, preferredId: string | null, unitGroup: string) => {
    const candidates = panelGroups.filter((entry) => entry.scope === scope);
    const panel = candidates.find((entry) => entry.groups.has(unitGroup))
      ?? candidates.find((entry) => entry.groups.size < 2)
      ?? (() => {
        const id = candidates.length === 0 && preferredId
          ? preferredId
          : nextPanelId(scope === "financial" ? "fundamentals" : "panel");
        const entry = { id, scope, groups: new Set<string>() };
        panelGroups.push(entry);
        reservedPanelIds.add(id);
        return entry;
      })();
    panel.groups.add(unitGroup);
    return panel.id;
  };

  parsedSeries.forEach((built) => {
    let candidate = built;
    if (built.panelId === "main") {
      const unitGroup = effectiveSeriesUnitGroup(built);
      const scope = mixedPriceAndFinancial
        ? isFinancialSeries(built)
          ? "financial"
          : isMarketPriceSeries(built) ? "price" : "other"
        : "main";
      const preferredId = scope === "financial"
        ? "fundamentals"
        : scope === "price" || scope === "main" ? "main" : null;
      candidate = {
        ...built,
        panelId: allocatePanel(scope, preferredId, unitGroup),
      };
      if (scope === "financial") {
        candidate = applySeriesTimestampMode(candidate, "available-at");
      }
    }
    builtSeries.push(coerceOhlcPanelCollision(candidate, builtSeries));
  });
  return builtSeries;
}

/**
 * Keep user-authored panel presentation while reconciling the panels needed by
 * the current series and studies. Indicator/formula toggles should only add or
 * remove their referenced panels; they must not reset labels, heights, order,
 * or logarithmic scales on panels that remain in use.
 */
function reconcilePanels(
  existing: readonly ChartPanelSpec[],
  series: readonly ChartSeriesSpec[],
  studies: readonly ChartStudySpec[],
): ChartPanelSpec[] {
  const defaults = panelsForSeries(series, studies);
  const requiredIds = new Set(defaults.map((panel) => panel.id));
  const managedStudyPanelIds = new Set(["volume", "rsi", "macd", "formula", "correlation"]);
  const retained = existing.filter((panel) => (
    requiredIds.has(panel.id) || !managedStudyPanelIds.has(panel.id)
  ));
  const retainedIds = new Set(retained.map((panel) => panel.id));
  return [
    ...retained,
    ...defaults.filter((panel) => !retainedIds.has(panel.id)),
  ];
}

function chartSpec(
  series: ChartSeriesSpec[],
  options: { range?: TimeRange; resolution?: ChartResolution; studies?: ChartStudySpec[] } = {},
): ChartSpec {
  const studies = options.studies ?? [];
  return {
    version: CHART_SPEC_VERSION,
    viewport: { range: options.range ?? "5Y", resolution: options.resolution ?? "auto" },
    panels: panelsForSeries(series, studies),
    series,
    studies,
  };
}

export function buildEmptyChartPreset(): ChartSpec {
  return chartSpec([]);
}

export function buildCustomChartPreset(expression: string, fallbackSymbol?: string | null): ChartSpec {
  const parsed = parseChartExpression(expression);
  if (parsed.length === 0) return fallbackSymbol ? buildPriceChartPreset(fallbackSymbol) : buildEmptyChartPreset();
  return chartSpec(buildCustomSeries(parsed));
}

export function buildPriceChartPreset(symbol: string): ChartSpec {
  const normalized = normalizeInstrument(symbol, true);
  if (!normalized) return buildEmptyChartPreset();
  return setBuiltinStudies(
    chartSpec([buildSeriesSpec({ kind: "security", ...normalized, fieldId: CHART_FIELD_IDS.price }, 0)]),
    ["volume"],
  );
}

/** Rebind research-context series without discarding authored chart choices. */
export function rebindChartSecuritySymbol(spec: ChartSpec, previous: string, next: string): ChartSpec {
  const previousInstrument = normalizeInstrument(previous, true);
  const nextInstrument = normalizeInstrument(next, true);
  if (!previousInstrument || !nextInstrument) return spec;
  const previousKey = publicTickerKey(previousInstrument.symbol, previousInstrument.exchange);
  const nextKey = publicTickerKey(nextInstrument.symbol, nextInstrument.exchange);
  if (previousKey === nextKey) return spec;
  let changed = false;
  const series = spec.series.map((entry) => {
    if (entry.source.kind !== "security"
      || publicTickerKey(entry.source.instrument.symbol, entry.source.instrument.exchange) !== previousKey) {
      return entry;
    }
    changed = true;
    const normalizedLabel = entry.label?.trim().toUpperCase();
    const label = normalizedLabel === previousKey || normalizedLabel === previousInstrument.symbol
      ? nextKey
      : entry.label;
    return {
      ...entry,
      ...(label ? { label } : { label: undefined }),
      source: {
        ...entry.source,
        instrument: nextInstrument,
      },
    };
  });
  return changed ? { ...spec, series } : spec;
}

export function buildIntradayPriceChartPreset(symbol: string): ChartSpec {
  const normalized = normalizeInstrument(symbol, true);
  if (!normalized) return buildEmptyChartPreset();
  return setBuiltinStudies(chartSpec([
    buildSeriesSpec(
      { kind: "security", ...normalized, fieldId: CHART_FIELD_IDS.price },
      0,
      { style: "candles" },
    ),
  ], { range: "1D", resolution: "1m" }), ["volume"]);
}

export function buildComparisonChartPreset(symbols: readonly string[]): ChartSpec {
  const normalized = symbols.map((symbol) => normalizeInstrument(symbol, true)).filter((entry): entry is NonNullable<typeof entry> => entry !== null).slice(0, MAX_CHART_COMPOSER_SERIES);
  return chartSpec(normalized.map((instrument, index) => buildSeriesSpec(
    { kind: "security", ...instrument, fieldId: CHART_FIELD_IDS.close },
    index,
    { style: "line", transform: "percent", axis: "left" },
  )), { range: "1Y", resolution: "1d" });
}

export function buildFundamentalChartPreset(
  symbols: readonly string[],
  fieldId = CHART_FIELD_IDS.revenue,
): ChartSpec {
  const resolvedField = resolveChartFieldAlias(fieldId);
  const normalized = symbols.map((symbol) => normalizeInstrument(symbol, true)).filter((entry): entry is NonNullable<typeof entry> => entry !== null).slice(0, MAX_CHART_COMPOSER_SERIES);
  return chartSpec(normalized.map((instrument, index) => buildSeriesSpec(
    { kind: "security", ...instrument, fieldId: resolvedField },
    index,
    { axis: "left" },
  )), { range: "5Y", resolution: "auto" });
}

export function buildValuationChartPreset(
  symbols: readonly string[],
  fieldId = CHART_FIELD_IDS.trailingPE,
): ChartSpec {
  const resolvedField = resolveChartFieldAlias(fieldId);
  const normalized = symbols.map((symbol) => normalizeInstrument(symbol, true)).filter((entry): entry is NonNullable<typeof entry> => entry !== null).slice(0, MAX_CHART_COMPOSER_SERIES);
  return chartSpec(normalized.map((instrument, index) => buildSeriesSpec(
    { kind: "security", ...instrument, fieldId: resolvedField },
    index,
    { style: normalized.length === 1 ? "line" : "columns", axis: "left" },
  )));
}

const STUDY_DEFAULTS = {
  volume: { kind: "volume", panelId: "volume", parameters: {} },
  sma20: { kind: "sma", panelId: "main", parameters: { period: 20 } },
  sma50: { kind: "sma", panelId: "main", parameters: { period: 50 } },
  sma200: { kind: "sma", panelId: "main", parameters: { period: 200 } },
  ema20: { kind: "ema", panelId: "main", parameters: { period: 20 } },
  bollinger20: { kind: "bollinger", panelId: "main", parameters: { period: 20, stdDev: 2 } },
  rsi14: { kind: "rsi", panelId: "rsi", parameters: { period: 14 } },
  macd: { kind: "macd", panelId: "macd", parameters: { fast: 12, slow: 26, signal: 9 } },
} as const satisfies Record<string, {
  kind: Exclude<ChartStudyKind, "ratio" | "spread" | "correlation">;
  panelId: string;
  parameters: Record<string, number>;
}>;

export type BuiltinStudySelection = keyof typeof STUDY_DEFAULTS;

const BUILTIN_STUDY_ID_PREFIX = "builtin:";

export function getSelectedBuiltinStudies(spec: ChartSpec): BuiltinStudySelection[] {
  const selected = new Set(spec.studies.flatMap((study) => {
    if (!study.id.startsWith(BUILTIN_STUDY_ID_PREFIX)) return [];
    const selection = study.id.slice(BUILTIN_STUDY_ID_PREFIX.length).split(":", 1)[0];
    return selection && Object.prototype.hasOwnProperty.call(STUDY_DEFAULTS, selection)
      ? [selection as BuiltinStudySelection]
      : [];
  }));
  return (Object.keys(STUDY_DEFAULTS) as BuiltinStudySelection[]).filter((selection) => selected.has(selection));
}

export function setBuiltinStudies(spec: ChartSpec, selected: readonly BuiltinStudySelection[]): ChartSpec {
  const input = spec.series.find((series) => (
    series.source.kind === "security"
    && (series.source.fieldId === CHART_FIELD_IDS.price || series.source.fieldId === CHART_FIELD_IDS.close)
  ));
  const selectedSet = new Set(selected);
  const customStudies = spec.studies.filter((study) => !study.id.startsWith(BUILTIN_STUDY_ID_PREFIX));
  const studies = input
    ? [
      ...customStudies,
      ...(Object.entries(STUDY_DEFAULTS) as Array<[BuiltinStudySelection, typeof STUDY_DEFAULTS[BuiltinStudySelection]]>)
        .filter(([selection]) => selectedSet.has(selection))
        .map(([selection, defaults]) => ({
          id: `${BUILTIN_STUDY_ID_PREFIX}${selection}:${input.id}`,
          kind: defaults.kind,
          inputSeriesIds: [input.id],
          parameters: defaults.parameters,
          panelId: defaults.panelId,
          axis: "auto" as const,
        })),
    ]
    : customStudies;
  return { ...spec, studies, panels: reconcilePanels(spec.panels, spec.series, studies) };
}

export type PairStudySelection = "ratio" | "spread" | "correlation";

const PAIR_STUDY_ID_PREFIX = "pair:";

export function getSelectedPairStudies(spec: ChartSpec): PairStudySelection[] {
  const selected = new Set(spec.studies.flatMap((study) => (
    study.id.startsWith(PAIR_STUDY_ID_PREFIX)
      ? [study.kind as PairStudySelection]
      : []
  )));
  return (["ratio", "spread", "correlation"] as PairStudySelection[])
    .filter((kind) => selected.has(kind));
}

export function setPairStudies(spec: ChartSpec, selected: readonly PairStudySelection[]): ChartSpec {
  const inputs = spec.series.filter((series) => series.visible !== false).slice(0, 2);
  const selectedSet = new Set(selected);
  const pairStudies: ChartStudySpec[] = inputs.length === 2
    ? (["ratio", "spread", "correlation"] as PairStudySelection[])
      .filter((kind) => selectedSet.has(kind))
      .map((kind): ChartStudySpec => ({
        id: `${PAIR_STUDY_ID_PREFIX}${kind}`,
        kind,
        inputSeriesIds: inputs.map((series) => series.id),
        parameters: kind === "spread"
          ? { multiplier: 1 }
          : kind === "correlation"
            ? { period: 20, returns: 1 }
            : {},
        panelId: kind === "correlation" ? "correlation" : "formula",
        axis: "auto",
      }))
    : [];
  const studies: ChartStudySpec[] = [
    ...spec.studies.filter((study) => !study.id.startsWith(PAIR_STUDY_ID_PREFIX)),
    ...pairStudies,
  ];
  return { ...spec, studies, panels: reconcilePanels(spec.panels, spec.series, studies) };
}
