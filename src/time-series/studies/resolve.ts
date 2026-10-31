import { effectiveTimeSeriesPointTime } from "../alignment";
import { mergePriceHistoryIntegrity } from "../../utils/price-history-integrity";
import { isRealizedVolatilityEstimator, realizedVolatilityCadenceIssue } from "../../market-data/realized-volatility";
import type { ManualChartResolution } from "../resolution";
import type { ChartStudyKind, ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "../types";
import { studyMessageName } from "../series-name";
import { isLeverageFactor, leverageFactorLabel, leverageSymbol, type StudyAnchor } from "../leverage";
import { KIND_COLORS, STUDY_COLORS } from "./shared";
import {
  resolveAtr,
  resolveBollinger,
  resolveMacd,
  resolveMovingAverage,
  resolveRealizedVolatility,
  resolveRsi,
  resolveVolume,
  studyWarmupPoints,
} from "./indicators";
import { resolveAnchoredVwap, resolveVolumeProfile, resolveVwap } from "./vwap";
import {
  fxConversionIssue,
  knownUnitSignature,
  legName,
  ratioUnit,
  seriesCurrency,
  unitCurrencies,
  unitMismatchMessage,
  type SeriesUnit,
} from "./units";
import { resolvePairStudy } from "./pair";
import { formulaTerms, formulaUnit, resolveFormula, type FormulaTerms } from "./formula";
import { dailyBarsIssue, resolveLeverageDecay, resolveLeverageLine } from "./leverage";

export interface StudyResolutionResult {
  series: ResolvedSeries[];
  warnings: string[];
  errors: string[];
}

export function maxStudyWarmupPoints(specs: readonly ChartStudySpec[]): number {
  return Math.max(0, ...specs.filter((spec) => spec.visible !== false).map(studyWarmupPoints));
}

/** Formulas of levels, which carry each input's latest value to the other inputs' dates. */
/** The study's own colour, or the next after it no series or formula on the chart has taken. */
function freeStudyColor(index: number, used: ReadonlySet<string>): string {
  for (let offset = 0; offset < STUDY_COLORS.length; offset += 1) {
    const color = STUDY_COLORS[(index + offset) % STUDY_COLORS.length]!;
    if (!used.has(color.toLowerCase())) return color;
  }
  return STUDY_COLORS[index % STUDY_COLORS.length]!;
}

function isLevelFormula(kind: ChartStudyKind): boolean {
  return kind === "ratio" || kind === "spread" || kind === "formula";
}

function requiredInputs(kind: ChartStudyKind): number {
  return kind === "ratio" || kind === "spread" || kind === "correlation" || kind === "leverage-decay" ? 2 : 1;
}

/**
 * A contradictory observation interrupts the input history. Running studies on
 * each continuous segment keeps finite windows from skipping the missing bar
 * and makes recursive indicators warm up again from valid observations.
 */
function resolveInterruptedStudy(
  inputs: readonly ResolvedSeries[],
  spec: ChartStudySpec,
  nameVolumeInput: boolean,
): StudyResolutionResult | null {
  const gaps = new Map<number, TimeSeriesPoint>();
  for (const input of inputs) {
    for (const point of input.points) {
      const integrity = point.provenance?.priceHistoryIntegrity;
      const priceIssues = point.provenance?.valuationPriceIssues;
      if (!integrity && !priceIssues?.length) continue;
      const timestamp = effectiveTimeSeriesPointTime(point);
      const previous = gaps.get(timestamp)?.provenance;
      gaps.set(timestamp, {
        date: new Date(timestamp), observedAt: new Date(timestamp), value: null,
        provenance: {
          quality: "derived",
          ...(integrity || previous?.priceHistoryIntegrity ? { priceHistoryIntegrity: previous?.priceHistoryIntegrity && integrity
            ? mergePriceHistoryIntegrity(previous.priceHistoryIntegrity, integrity) : integrity ?? previous?.priceHistoryIntegrity } : {}),
          ...(priceIssues?.length || previous?.valuationPriceIssues?.length
            ? { valuationPriceIssues: [...(previous?.valuationPriceIssues ?? []), ...(priceIssues ?? [])] } : {}),
        },
      });
    }
  }
  if (!gaps.size) return null;
  const times = [...gaps.keys()].sort((left, right) => left - right);
  const outputs = new Map<string, ResolvedSeries>();
  const warnings = new Set<string>();
  const errors = new Set<string>();
  const cursors = inputs.map((input) => ({
    input,
    points: [...input.points].sort((left, right) => effectiveTimeSeriesPointTime(left) - effectiveTimeSeriesPointTime(right)),
    index: 0,
    previous: undefined as TimeSeriesPoint | undefined,
  }));
  let start = Number.NEGATIVE_INFINITY;
  for (const end of [...times, Number.POSITIVE_INFINITY]) {
    const segmentInputs = cursors.map((cursor) => {
      while (cursor.index < cursor.points.length && effectiveTimeSeriesPointTime(cursor.points[cursor.index]!) <= start) {
        cursor.previous = cursor.points[cursor.index++];
      }
      const previous = cursor.previous;
      const points: TimeSeriesPoint[] = [];
      while (cursor.index < cursor.points.length && effectiveTimeSeriesPointTime(cursor.points[cursor.index]!) < end) {
        const point = cursor.points[cursor.index++]!;
        points.push(point);
        cursor.previous = point;
      }
      // A valid unaffected peer remains usable for as-of ratio/spread levels.
      // Correlations instead restart their shared observations and returns.
      if (isLevelFormula(spec.kind)) {
        if (previous && !previous.provenance?.priceHistoryIntegrity && !previous.provenance?.valuationPriceIssues?.length) points.unshift(previous);
      }
      return { ...cursor.input, points };
    });
    const segment = resolveStudySpecs(segmentInputs, [spec], nameVolumeInput);
    for (const output of segment.series) {
      const points = output.points.filter((point) => effectiveTimeSeriesPointTime(point) > start);
      const gap = gaps.get(start);
      if (gap && !isLevelFormula(spec.kind) && spec.kind !== "volume") {
        // A gap just outside the visible window still invalidates the next
        // warmup observations. Keep those nulls and their original diagnostic
        // explicit so clipping cannot hide why a study is unavailable.
        const firstComputed = points[0] ? effectiveTimeSeriesPointTime(points[0]) : Number.POSITIVE_INFINITY;
        points.unshift(...segmentInputs[0]!.points.filter((point) => effectiveTimeSeriesPointTime(point) < firstComputed).map((point) => ({
          date: new Date(point.date), observedAt: new Date(point.observedAt),
          availableAt: point.availableAt ? new Date(point.availableAt) : undefined,
          value: null, provenance: gap.provenance,
        })));
      }
      const previous = outputs.get(output.id);
      outputs.set(output.id, { ...output, points: [...(previous?.points ?? []), ...points] });
    }
    for (const warning of segment.warnings) {
      if (!warning.includes("not enough valid history")) warnings.add(warning);
    }
    for (const error of segment.errors) errors.add(error);
    start = end;
  }
  for (const output of outputs.values()) {
    output.points.push(...gaps.values());
    output.points.sort((left, right) => left.date.getTime() - right.date.getTime());
  }
  return { series: [...outputs.values()], warnings: [...warnings], errors: [...errors] };
}

/** Base series that must be calculated for currently visible studies. */
export function activeStudyInputSeriesIds(
  studySpecs: readonly ChartStudySpec[],
): Set<string> {
  return new Set(studySpecs
    .filter((spec) => spec.visible !== false)
    .flatMap((spec) => spec.inputSeriesIds));
}

/**
 * `anchors`: where each input series is measured from and to, for studies
 * that read returns over the chart's period (a leveraged fund's daily line and
 * its decay start where a comparison starts its legs). Without one, a series'
 * own first and last observations.
 */
export function resolveStudies(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
  marketResolution?: ManualChartResolution,
  historicalPriceSeries?: ReadonlyMap<string, ResolvedSeries>,
  anchors?: ReadonlyMap<string, StudyAnchor>,
): StudyResolutionResult {
  // With one security on the chart its volume is just "Volume"; beside a
  // comparison the legend names whose volume it is.
  const nameVolumeInput = baseSeries.filter((series) => series.observationKind === "market").length > 1;
  return resolveStudySpecs(baseSeries, studySpecs, nameVolumeInput, marketResolution, historicalPriceSeries, anchors);
}

function resolveStudySpecs(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
  nameVolumeInput: boolean,
  marketResolution?: ManualChartResolution,
  historicalPriceSeries?: ReadonlyMap<string, ResolvedSeries>,
  anchors?: ReadonlyMap<string, StudyAnchor>,
): StudyResolutionResult {
  const byId = new Map(baseSeries.map((series) => [series.id, series]));
  // A formula never takes a colour a series on the chart has: a crack in euros is not drawn in its EURUSD leg's yellow.
  const usedColors = new Set(baseSeries.map((series) => series.color.toLowerCase()));
  const resolved: ResolvedSeries[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  studySpecs.forEach((spec, index) => {
    if (spec.visible === false) return;
    const required = spec.kind === "formula" ? Math.max(1, spec.inputSeriesIds.length) : requiredInputs(spec.kind);
    const inputs = spec.inputSeriesIds.map((id) => spec.kind === "realized-vol"
      ? historicalPriceSeries?.get(id) ?? byId.get(id) : byId.get(id));
    if (inputs.length !== required || inputs.some((input) => !input)) {
      errors.push(`${studyMessageName(spec)}: ${spec.kind} requires ${required} valid input series.`);
      return;
    }
    const input = inputs[0]!;
    if (spec.kind === "spread") {
      const pairedInput = inputs[1]!;
      const inputUnit = knownUnitSignature(input);
      if (inputUnit === null || inputUnit !== knownUnitSignature(pairedInput)) {
        errors.push(`${studyMessageName(spec)}: ${unitMismatchMessage("spread", { series: input, unit: input.unit }, { series: pairedInput, unit: pairedInput.unit })}`);
        return;
      }
    }
    let formula: { terms: FormulaTerms; unit: SeriesUnit } | null = null;
    if (spec.kind === "formula") {
      const terms = formulaTerms(spec, inputs as ResolvedSeries[]);
      const unit = "error" in terms ? terms : formulaUnit(terms, inputs as ResolvedSeries[]);
      if ("error" in unit) {
        errors.push(`${studyMessageName(spec)}: ${unit.error}`);
        return;
      }
      formula = { terms: terms as FormulaTerms, unit };
    }
    const color = spec.color ?? KIND_COLORS[spec.kind]
      ?? (isLevelFormula(spec.kind) ? freeStudyColor(index, usedColors) : STUDY_COLORS[index % STUDY_COLORS.length]!);
    if (isLevelFormula(spec.kind)) usedColors.add(color.toLowerCase());
    if (spec.kind === "leverage" || spec.kind === "leverage-decay") {
      const index = inputs.at(-1)!;
      if (!isLeverageFactor(spec.parameters.factor)) {
        errors.push(`${studyMessageName(spec)}: choose a nonzero leverage factor of at most 5.`);
        return;
      }
      const issue = inputs.map((entry) => dailyBarsIssue(spec, entry!, marketResolution)).find(Boolean);
      if (issue) {
        warnings.push(issue);
        return;
      }
      const outputs = spec.kind === "leverage"
        ? resolveLeverageLine(spec, index, color, anchors?.get(index.id))
        : resolveLeverageDecay(spec, input, index, anchors);
      if (outputs.every((output) => output.points.length < 2)) {
        warnings.push(`${studyMessageName(spec)}: not enough shared daily closes to measure ${leverageFactorLabel(spec.parameters.factor as number)} daily ${leverageSymbol(index)}.`);
      }
      resolved.push(...outputs);
      return;
    }
    if (spec.kind === "realized-vol") {
      const window = spec.parameters.window ?? 30;
      if (typeof window !== "number" || !Number.isInteger(window) || window < 2
        || (spec.parameters.estimator !== undefined && !isRealizedVolatilityEstimator(spec.parameters.estimator))) {
        errors.push(`${studyMessageName(spec)}: choose a supported volatility estimator and a whole window of at least two sessions.`);
        return;
      }
      const inputResolution = input.historyResolution === undefined ? marketResolution : input.historyResolution;
      if (input.nativeFrequency !== "daily"
        || (inputResolution !== undefined && inputResolution !== "1d")
        || (input.timeBasis?.cadenceMs !== undefined && input.timeBasis.cadenceMs !== 86_400_000)
        || !(input.unitGroup === "price" || input.unitGroup.startsWith("price:"))) {
        errors.push(`${studyMessageName(spec)}: realized volatility requires daily prices. Choose Auto or 1D resolution and a daily price source.`);
        return;
      }
      const cadenceIssue = realizedVolatilityCadenceIssue(input.points);
      if (cadenceIssue) {
        errors.push(`${studyMessageName(spec)}: ${cadenceIssue}`);
        return;
      }
      const outputs = resolveRealizedVolatility(spec, input, color);
      if (outputs.every((output) => output.points.every((point) => point.value === null))) {
        warnings.push(`${studyMessageName(spec)}: not enough valid daily history to calculate ${spec.parameters.estimator ?? "close-to-close"} realized volatility.`);
      }
      resolved.push(...outputs);
      return;
    }
    const interrupted = resolveInterruptedStudy(inputs as ResolvedSeries[], { ...spec, color }, nameVolumeInput);
    if (interrupted) {
      resolved.push(...interrupted.series);
      warnings.push(...interrupted.warnings);
      errors.push(...interrupted.errors);
      return;
    }
    let outputs: ResolvedSeries[] = [];
    if (spec.kind === "sma") outputs = resolveMovingAverage(spec, input, color, false);
    else if (spec.kind === "ema") outputs = resolveMovingAverage(spec, input, color, true);
    else if (spec.kind === "bollinger") outputs = resolveBollinger(spec, input, color);
    else if (spec.kind === "rsi") outputs = resolveRsi(spec, input, color);
    else if (spec.kind === "macd") outputs = resolveMacd(spec, input, color);
    else if (spec.kind === "atr") outputs = resolveAtr(spec, input, color, nameVolumeInput);
    else if (spec.kind === "vwap" || spec.kind === "anchored-vwap" || spec.kind === "volume-profile") {
      outputs = spec.kind === "vwap"
        ? resolveVwap(spec, input, color, nameVolumeInput, marketResolution, warnings)
        : spec.kind === "anchored-vwap"
          ? resolveAnchoredVwap(spec, input, color, marketResolution, warnings)
          : resolveVolumeProfile(spec, input, color, warnings);
      resolved.push(...outputs);
      return;
    }
    else if (spec.kind === "formula" && formula) outputs = resolveFormula(spec, inputs as ResolvedSeries[], formula.terms, formula.unit, color);
    else if (spec.kind === "volume") {
      outputs = resolveVolume(spec, input, color, nameVolumeInput);
      if (!input.volumeUnit && outputs.some((output) => output.points.length > 0)) {
        warnings.push(`Volume unit unknown: ${input.label}.`);
      }
    }
    else {
      const pairedInput = inputs[1]!;
      const inputCurrency = seriesCurrency(input);
      const pairedCurrency = seriesCurrency(pairedInput);
      const differentCurrencies = inputCurrency !== null
        && pairedCurrency !== null
        && inputCurrency !== pairedCurrency;
      // Over an FX rate a price is converted, leaving one currency: EUR / barrel.
      const ratio = spec.kind === "ratio" ? ratioUnit(input, pairedInput) : null;
      if (ratio && differentCurrencies && unitCurrencies(ratio.unit).size !== 1) {
        const issue = fxConversionIssue(input, pairedInput, -1, ratio, legName(input));
        warnings.push(`${studyMessageName(spec)}: ${issue
          ?? `${spec.kind} inputs use different currencies (${inputCurrency} and ${pairedCurrency}); raw values are not FX-converted.`}`);
      }
      if (spec.kind === "correlation" && input.nativeFrequency !== pairedInput.nativeFrequency) {
        warnings.push(`${studyMessageName(spec)}: correlation mixes ${input.nativeFrequency} and ${pairedInput.nativeFrequency} observations; only matching observation times contribute.`);
      }
      outputs = resolvePairStudy(spec, input, pairedInput, color);
    }
    if (
      spec.kind !== "volume"
      && (outputs.length === 0 || outputs.every((output) => output.points.length === 0))
    ) {
      warnings.push(`${studyMessageName(spec)}: not enough valid history to calculate ${spec.kind}.`);
    }
    resolved.push(...outputs);
  });
  return { series: resolved, warnings, errors };
}
