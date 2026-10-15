import {
  CHART_SPEC_VERSION,
  type ChartSeriesSpec,
  type ChartSpec,
  type ChartStudySpec,
} from "../../../time-series/types";
import type { ChartResolution, TimeRange } from "../../../components/chart/core/types";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";
import { buildCustomSeries, buildSeriesSpec, panelsForSeries } from "./chart-spec-edit";
import { currencyPairSpelling } from "../../../utils/currency-pair";
import { dashedCoinPair } from "../../../utils/crypto-pair";
import {
  CHART_FIELD_IDS,
  normalizeInstrument,
  parseChartExpression,
  parseSeriesExpression,
  resolveChartFieldAlias,
  type ParsedSeriesExpression,
} from "./series-expression";
import { setBuiltinStudies, setPairStudies, type PairStudySelection } from "./studies";

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
 * a field written with a slash (`AAPL:EV/EBITDA`). A comma-separated list stays a list.
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
  const quote = rightToken.split(":")[0]!;
  if (currencyPairSpelling(`${leftToken}/${quote}`) || dashedCoinPair(`${leftToken}/${quote}`)) return null;
  const left = parseSeriesExpression(leftToken);
  const right = parseSeriesExpression(rightToken);
  if (!left || !right) return null;
  return { series: [left, right], formula: "ratio" };
}

export function buildCustomChartPreset(expression: string, fallbackSymbol?: string | null): ChartSpec {
  const derived = derivedPair(expression);
  if (derived) return setPairStudies(chartSpec(buildCustomSeries(derived.series)), [derived.formula]);
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
