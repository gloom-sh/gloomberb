import { formatFuturesGeneric, futuresGenericListing, isSameFuturesGeneric, type FuturesGeneric } from "../../../utils/futures-generic";
import type {
  ChartPanelSpec,
  ChartSeriesSpec,
  ChartSpec,
  ChartStudySpec,
  SeriesAxis,
  SeriesPeriod,
  SeriesStyle,
  SeriesTimestampMode,
  SeriesTransform,
} from "../../../time-series/types";
import {
  canonicalTimeSeriesFieldId,
  getTimeSeriesField,
  isFundamentalFieldId,
} from "../../../time-series/field-catalog";
import {
  coerceSeriesInterpolationForStyle,
  coerceSeriesTransformForStyle,
  isOhlcSeriesStyle,
} from "../../../time-series/spec";
import { parsePublicTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { CHART_FIELD_IDS, normalizeInstrument, type ParsedSeriesExpression } from "./series-expression";

/** The chart's first generic future (CL1), whose roll and adjustment the pane's controls show. */
export function chartFuturesGeneric(spec: ChartSpec): FuturesGeneric | null {
  for (const entry of spec.series) {
    const generic = entry.source.kind === "security" ? futuresGenericListing(entry.source.instrument.symbol, entry.source.instrument.exchange) : null;
    if (generic) return generic;
  }
  return null;
}

/** Moves every generic future on the chart to another roll rule or adjustment; each is its own ticker (CL1F5R). */
export function setChartFuturesGeneric(spec: ChartSpec, change: Partial<Pick<FuturesGeneric, "roll" | "adjust">>): ChartSpec {
  let changed = false;
  const series = spec.series.map((entry) => {
    if (entry.source.kind !== "security") return entry;
    const generic = futuresGenericListing(entry.source.instrument.symbol, entry.source.instrument.exchange);
    if (!generic) return entry;
    const symbol = formatFuturesGeneric({ ...generic, ...change });
    if (symbol === generic.ticker) return entry;
    changed = true;
    return { ...entry, source: { ...entry.source, instrument: { ...entry.source.instrument, symbol } } };
  });
  return changed ? { ...spec, series } : spec;
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
  if (expression.kind === "capability") {
    const style = overrides.style ?? expression.style ?? "line";
    return {
      id: `${slug(expression.capabilityId)}-${slug(expression.seriesId)}-${index + 1}`,
      source: {
        kind: "capability",
        capabilityId: expression.capabilityId,
        seriesId: expression.seriesId,
      },
      ...(expression.label ? { label: expression.label } : {}),
      transform: expression.transform ?? "raw",
      axis: "auto",
      panelId: "main",
      ...overrides,
      style,
      interpolation: coerceSeriesInterpolationForStyle(style),
    };
  }
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
    : series.source.kind === "capability"
      ? `capability:${series.source.capabilityId}`
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

export function panelsForSeries(series: readonly ChartSeriesSpec[], studies: readonly ChartStudySpec[] = []): ChartPanelSpec[] {
  const panelIds = new Set(["main", ...series.map((entry) => entry.panelId), ...studies.map((entry) => entry.panelId)]);
  return [...panelIds].map((id) => ({
    id,
    ...(id === "volume" ? { label: "Volume", height: 0.24 } : {}),
    ...(id === "fundamentals" || /^fundamentals-\d+$/.test(id)
      ? { label: id === "fundamentals" ? "Fundamentals" : `Fundamentals ${id.slice("fundamentals-".length)}`, height: 0.35 }
      : {}),
    ...(id === "rsi" || id === "macd" || id === "atr" ? { label: id.toUpperCase(), height: 0.28 } : {}),
    ...(id === "formula" ? { label: "Formula", height: 0.3 } : {}),
    ...(id === "correlation" ? { label: "Correlation", height: 0.3 } : {}),
    ...(id === "realized-vol" ? { label: "Realized Volatility", height: 0.3 } : {}),
    ...(/^panel-\d+$/.test(id) ? { label: `Panel ${id.slice("panel-".length)}`, height: 0.35 } : {}),
  }));
}

/** Keep arbitrary sources legible when one panel would require more than two axes. */
export function buildCustomSeries(expressions: readonly ParsedSeriesExpression[]): ChartSeriesSpec[] {
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
export function reconcilePanels(
  existing: readonly ChartPanelSpec[],
  series: readonly ChartSeriesSpec[],
  studies: readonly ChartStudySpec[],
): ChartPanelSpec[] {
  const defaults = panelsForSeries(series, studies);
  const requiredIds = new Set(defaults.map((panel) => panel.id));
  const managedStudyPanelIds = new Set(["volume", "rsi", "macd", "atr", "formula", "correlation", "realized-vol"]);
  const retained = existing.filter((panel) => (
    requiredIds.has(panel.id) || !managedStudyPanelIds.has(panel.id)
  ));
  const retainedIds = new Set(retained.map((panel) => panel.id));
  return [
    ...retained,
    ...defaults.filter((panel) => !retainedIds.has(panel.id)),
  ];
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

/** Follow the research listing, including its venue, while keeping comparisons. */
export function rebindResearchChartSpec(spec: ChartSpec, previous: string | null, next: string | null): ChartSpec {
  const nextInstrument = next ? normalizeInstrument(next, true) : null;
  if (!nextInstrument) return spec;
  const previousInstrument = previous ? normalizeInstrument(previous, true) : null;
  const previousKey = previousInstrument && publicTickerKey(previousInstrument.symbol, previousInstrument.exchange);
  const nextKey = publicTickerKey(nextInstrument.symbol, nextInstrument.exchange);
  const securityKeys = spec.series.flatMap((entry) => entry.source.kind === "security"
    ? [publicTickerKey(entry.source.instrument.symbol, entry.source.instrument.exchange)]
    : []);
  if (previousKey && securityKeys.includes(previousKey)) {
    return rebindChartSecuritySymbol(spec, previousKey, nextKey);
  }
  // A restored chart can already contain the target after its old context was
  // lost. Do not replace an unrelated first comparison in that case.
  if (securityKeys.includes(nextKey)) return spec;
  // The Roll and Adjust controls rewrite a generic (CL1 to CL1F5R); it still
  // follows the same ticker, and moves on only when the ticker does.
  const followed = parsePublicTickerKey(previousKey ?? nextKey);
  const variant = securityKeys.find((key) => isSameFuturesGeneric(parsePublicTickerKey(key), followed));
  if (variant) return !previousKey || previousKey === nextKey ? spec : rebindChartSecuritySymbol(spec, variant, nextKey);
  const primary = securityKeys[0];
  return primary ? rebindChartSecuritySymbol(spec, primary, nextKey) : spec;
}
