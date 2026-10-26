import {
  CHART_SPEC_VERSION,
  type ChartSeriesSpec,
  type ChartSpec,
  type ChartStudySpec,
} from "../../../time-series/types";
import type { ChartResolution, TimeRange } from "../../../components/chart/core/types";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";
import { appendChartSeries, appendPlacedSeries, buildCustomSeries, buildSeriesSpec, nextGeneratedPanelId, panelsForSeries } from "./chart-spec-edit";
import { currencyPairSpelling } from "../../../utils/currency-pair";
import { dashedCoinPair } from "../../../utils/crypto-pair";
import {
  CHART_FIELD_IDS,
  formatSeriesExpression,
  normalizeInstrument,
  parseChartExpression,
  parseSeriesExpression,
  resolveChartFieldAlias,
  type ParsedSeriesExpression,
} from "./series-expression";
import { setBuiltinStudies, setPairStudies, type PairStudySelection } from "./studies";
import { looksLikeFormula, parseFormulaExpression, type ParsedFormula } from "./formula";
import type { SeriesCatalogSuggestion } from "./series-catalog";
import { getSharedRegistry } from "../../registry";
import { seriesCatalogEntry } from "../../../series/registry";

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

/**
 * `GAA/VOO`, `GAA / VOO`, and `CL=F - ES=F` are a ratio or a spread of two series.
 * A slash that is the symbol stays one series (`EUR/USD`, `BTC/USD`), and so does
 * a field written with a slash (`AAPL:EV/EBITDA`) and the symbol a catalog series
 * takes after one (`CAP:short-volume:ratio/AAPL`). A comma-separated list stays a list.
 */
function derivedPair(expression: string): { series: ParsedSeriesExpression[]; formula: PairStudySelection } | null {
  const trimmed = expression.trim();
  if (!trimmed || /[;,\n]/.test(trimmed)) return null;
  const spaced = /^(.*?)\s+(\/|-)\s+(.*)$/.exec(trimmed);
  if (spaced) {
    const left = parseSeriesExpression(spaced[1]!);
    const right = parseSeriesExpression(spaced[3]!);
    if (!left || !right) return null;
    return { series: [left, right], formula: spaced[2] === "/" ? "ratio" : "spread" };
  }
  const tight = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!tight) return null;
  const [leftToken, rightToken] = [tight[1]!, tight[2]!];
  if (/^CAP:/i.test(leftToken) && !/^CAP:/i.test(rightToken)) return null;
  const quote = rightToken.split(":")[0]!;
  if (currencyPairSpelling(`${leftToken}/${quote}`) || dashedCoinPair(`${leftToken}/${quote}`)) return null;
  const left = parseSeriesExpression(leftToken);
  const right = parseSeriesExpression(rightToken);
  if (!left || !right) return null;
  return { series: [left, right], formula: "ratio" };
}

/** The study id of a chart's series formula; a chart draws one. */
const FORMULA_STUDY_ID = "formula";

/**
 * A leg taken per barrel (42*HO=F) is a price per gallon; beside one per
 * barrel (CL=F) it reads on its own axis, not flattened along the crude's.
 */
function placeFormulaLeg(formula: ParsedFormula, index: number, series: ChartSeriesSpec): ChartSeriesSpec {
  const mixed = formula.legs.some((leg) => leg.perBarrel) && formula.legs.some((leg) => !leg.perBarrel);
  return mixed && series.panelId === "main" && !formula.legs[index]!.perBarrel ? { ...series, axis: "right" } : series;
}

/**
 * A series the formula is divided or multiplied by (an FX rate) counts
 * something else again: it is drawn in a panel of its own, not on the legs' axes.
 */
function placeFormulaFactor(spec: Pick<ChartSpec, "panels" | "series" | "studies">, series: ChartSeriesSpec): ChartSeriesSpec {
  return { ...series, panelId: nextGeneratedPanelId(spec), axis: "auto" };
}

/** A factor's panel is shorter than a series panel, so the legs and the formula keep their room. */
const FACTOR_PANEL_HEIGHT = 0.2;

/** The panels with each new factor's last and short: the formula reads right under its legs. */
function withFactorPanels(panels: ChartSpec["panels"], factors: readonly ChartSeriesSpec[]): ChartSpec["panels"] {
  const ids = new Set(factors.map((series) => series.panelId));
  return [
    ...panels.filter((panel) => !ids.has(panel.id)),
    ...panels.filter((panel) => ids.has(panel.id)).map((panel) => ({ ...panel, height: FACTOR_PANEL_HEIGHT })),
  ];
}

/** The study that weighs a formula's legs and scales the sum, charted as the given series, in the Formula panel. */
function formulaStudy(formula: ParsedFormula, inputSeriesIds: string[]): ChartStudySpec {
  const parameters: ChartStudySpec["parameters"] = { divisor: formula.divisor };
  formula.legs.forEach((leg, index) => {
    parameters[`weight${index + 1}`] = leg.weight;
    if (leg.perBarrel) parameters[`perBarrel${index + 1}`] = 1;
    if (leg.perTonne) parameters[`perTonne${index + 1}`] = leg.perTonne;
  });
  formula.factors.forEach((factor, index) => {
    parameters[`power${formula.legs.length + index + 1}`] = factor.power;
  });
  return { id: FORMULA_STUDY_ID, kind: "formula", inputSeriesIds, parameters, panelId: "formula", axis: "auto" };
}

/** A formula's legs and factors as series, with the study that sums them in the Formula panel. */
function formulaChartPreset(formula: ParsedFormula): ChartSpec {
  const legs = buildCustomSeries([...formula.legs, ...formula.factors].map((entry) => entry.series));
  const series: ChartSeriesSpec[] = [];
  legs.forEach((entry, index) => {
    series.push(index < formula.legs.length
      ? placeFormulaLeg(formula, index, entry)
      : placeFormulaFactor({ panels: [], series, studies: [] }, entry));
  });
  const spec = chartSpec(series, { studies: [formulaStudy(formula, series.map((entry) => entry.id))] });
  return { ...spec, panels: withFactorPanels(spec.panels, series.slice(formula.legs.length)) };
}

/**
 * The chart with a formula added: a leg already charted is reused, the rest
 * join the series, and the formula replaces the one the chart had.
 */
function appendChartFormula(spec: ChartSpec, expression: string): { spec: ChartSpec; series: ChartSeriesSpec } {
  const formula = parseFormulaExpression(expression);
  if (!formula) throw new Error(`"${expression}" is not a formula.`);
  const key = (series: ChartSeriesSpec) => formatSeriesExpression(series).toLowerCase();
  const terms = [...formula.legs, ...formula.factors];
  const legs = terms.map((leg) => key(buildSeriesSpec(leg.series, 0)));
  const missing = legs.filter((leg) => !spec.series.some((series) => key(series) === leg)).length;
  if (spec.series.length + missing > MAX_CHART_COMPOSER_SERIES) {
    throw new Error(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
  }
  let next: ChartSpec = { ...spec, studies: spec.studies.filter((study) => study.id !== FORMULA_STUDY_ID) };
  const placedFactors: ChartSeriesSpec[] = [];
  const inputs = terms.map((leg, index) => {
    const charted = next.series.find((series) => key(series) === legs[index]);
    if (charted) return charted;
    const appended = appendChartSeries(next, leg.series);
    const placed = index < formula.legs.length
      ? placeFormulaLeg(formula, index, appended.series)
      : placeFormulaFactor(next, appended.series);
    if (index >= formula.legs.length) placedFactors.push(placed);
    next = { ...appended.spec, series: appended.spec.series.map((series) => series.id === placed.id ? placed : series) };
    return placed;
  });
  const studies = [...next.studies, formulaStudy(formula, inputs.map((series) => series.id))];
  const known = new Set(next.panels.map((panel) => panel.id));
  return {
    spec: {
      ...next,
      studies,
      panels: withFactorPanels(
        [...next.panels, ...panelsForSeries(next.series, studies).filter((panel) => !known.has(panel.id))],
        placedFactors,
      ),
    },
    series: inputs.at(-1)!,
  };
}

/**
 * The chart with a catalog suggestion added: one series, a registered
 * series' lines where it asks for them, or a formula's legs and its study.
 */
export function appendCatalogSuggestion(
  spec: ChartSpec,
  suggestion: SeriesCatalogSuggestion,
): { spec: ChartSpec; series: ChartSeriesSpec } {
  if (suggestion.formula !== undefined) return appendChartFormula(spec, suggestion.formula);
  if (suggestion.lines || suggestion.placement) {
    return appendPlacedSeries(spec, suggestion.lines ?? [suggestion.expression!], {
      name: suggestion.seriesName ?? suggestion.label,
      ...(suggestion.placement ? { placement: suggestion.placement } : {}),
      ...(suggestion.symbol ? { symbol: suggestion.symbol } : {}),
    });
  }
  return appendChartSeries(spec, suggestion.expression);
}

/**
 * The chart CAT opens for a registered series that asks where it is drawn or
 * draws several lines: the ticker's price with the series placed as it asks,
 * or the lines on their own.
 */
export function buildRegisteredSeriesChart(
  series: { name: string; template: string; placement?: SeriesCatalogSuggestion["placement"]; lines?: ReadonlyArray<{ name: string; expression: string; style?: ChartSeriesSpec["style"] }> },
  symbol?: string,
): ChartSpec {
  const fill = (template: string) => symbol
    ? template.replaceAll("{ticker}", template.startsWith("CAP:") ? encodeURIComponent(symbol) : symbol)
    : template;
  const prefix = symbol ? `${symbol} · ` : "";
  const lines = series.lines?.length
    ? series.lines.map((line) => {
      const parsed = parseSeriesExpression(fill(line.expression));
      if (!parsed) throw new Error(`"${line.expression}" is not a chart series.`);
      return { ...parsed, label: `${prefix}${series.name} · ${line.name}`, ...(line.style ? { style: line.style } : {}) };
    })
    : [(() => {
      const parsed = parseSeriesExpression(fill(series.template));
      if (!parsed) throw new Error(`"${series.template}" is not a chart series.`);
      return { ...parsed, label: `${prefix}${series.name}` };
    })()];
  const base = series.placement && symbol ? buildPriceChartPreset(symbol) : buildEmptyChartPreset();
  return appendPlacedSeries(base, lines, {
    name: series.name,
    ...(series.placement && symbol ? { placement: series.placement, symbol } : {}),
  }).spec;
}

/**
 * A chart of what was typed: one series or a list, a pair (`A / B`, `A - B`),
 * or a formula (`42*HO=F - CL=F`).
 */
export function buildCustomChartPreset(expression: string, fallbackSymbol?: string | null): ChartSpec {
  const derived = derivedPair(expression);
  if (derived) return setPairStudies(chartSpec(buildCustomSeries(derived.series)), [derived.formula]);
  let parsed: ParsedSeriesExpression[];
  try {
    parsed = parseChartExpression(expression);
  } catch (error) {
    // Text a list cannot read, written as a formula, gets the formula's own error.
    if (!looksLikeFormula(expression)) throw error;
    const formula = parseFormulaExpression(expression);
    if (!formula) throw error;
    return formulaChartPreset(formula);
  }
  if (parsed.length === 0) return fallbackSymbol ? buildPriceChartPreset(fallbackSymbol) : buildEmptyChartPreset();
  const registered = parsed.length === 1 ? placedRegisteredSeries(parsed[0]!) : null;
  if (registered) return buildRegisteredSeriesChart(registered.series, registered.ticker);
  return chartSpec(buildCustomSeries(parsed));
}

/**
 * A registered series typed alone (`CAP:studies:rsi/AAPL`) that says where it is
 * drawn or draws several lines charts as CAT opens it. Naming one line
 * (`rsi~signal/AAPL`) charts that line alone.
 */
function placedRegisteredSeries(expression: ParsedSeriesExpression) {
  if (expression.kind !== "capability" || expression.seriesId.split("/")[0]!.includes("~")) return null;
  const found = getSharedRegistry()?.series?.findLoaded(expression.capabilityId, expression.seriesId);
  if (!found || (!found.series.definition.placement && !found.series.definition.lines?.length)) return null;
  const entry = seriesCatalogEntry(found.series);
  return {
    series: { name: entry.name, template: entry.expression, placement: entry.placement, lines: entry.lines },
    ...(found.ticker ? { ticker: found.ticker } : {}),
  };
}

export function buildPriceChartPreset(symbol: string, range?: TimeRange): ChartSpec {
  const normalized = normalizeInstrument(symbol, true);
  if (!normalized) return buildEmptyChartPreset();
  return setBuiltinStudies(
    chartSpec([buildSeriesSpec({ kind: "security", ...normalized, fieldId: CHART_FIELD_IDS.price }, 0)], { range }),
    ["volume"],
  );
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
  return chartSpec(normalized.map((instrument, index) => {
    const series = buildSeriesSpec(
      { kind: "security", ...instrument, fieldId: resolvedField },
      index,
      { style: "line", axis: "left" },
    );
    return series.source.kind === "security" ? { ...series, source: { ...series.source, period: "daily" } } : series;
  }));
}
