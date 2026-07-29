import { alignTimeSeries, scalarPointValue } from "./alignment";
import type {
  ChartStudyKind,
  ChartStudySpec,
  ResolvedSeries,
  SeriesAxis,
  SeriesInterpolation,
  SeriesPeriod,
  SeriesStyle,
  TimeSeriesPoint,
} from "./types";

export interface StudyResolutionResult {
  series: ResolvedSeries[];
  warnings: string[];
  errors: string[];
}

interface NumericSample {
  point: TimeSeriesPoint;
  value: number;
}

interface IndexedValue {
  index: number;
  value: number;
}

const STUDY_COLORS = ["#f6c85f", "#4dabf7", "#b197fc", "#63e6be", "#ffa94d", "#ff6b6b"];

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return finiteNumber(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function samplesFor(series: ResolvedSeries): NumericSample[] {
  return [...series.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => {
      const value = scalarPointValue(point);
      return value === null ? [] : [{ point, value }];
    });
}

function derivedPoint(sample: NumericSample, value: number | null): TimeSeriesPoint {
  return {
    date: new Date(sample.point.date),
    observedAt: new Date(sample.point.observedAt),
    availableAt: sample.point.availableAt ? new Date(sample.point.availableAt) : undefined,
    value,
    periodLabel: sample.point.periodLabel,
    provenance: {
      providerId: sample.point.provenance?.providerId,
      quality: "derived",
    },
  };
}

function outputSeries(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  options: {
    id?: string;
    label: string;
    points: TimeSeriesPoint[];
    color: string;
    unit?: string;
    unitGroup?: string;
    style?: SeriesStyle;
    interpolation?: SeriesInterpolation;
    axis?: Exclude<SeriesAxis, "auto">;
    nativeFrequency?: SeriesPeriod;
  },
): ResolvedSeries {
  return {
    id: options.id ?? spec.id,
    label: options.label,
    color: options.color,
    unit: options.unit ?? input.unit,
    unitGroup: options.unitGroup ?? input.unitGroup,
    nativeFrequency: options.nativeFrequency ?? input.nativeFrequency,
    dataShape: "scalar",
    style: options.style ?? "line",
    transform: "raw",
    axis: spec.axis === "auto" ? options.axis ?? input.axis : spec.axis,
    panelId: spec.panelId,
    interpolation: options.interpolation ?? "none",
    timeBasis: input.timeBasis,
    points: options.points,
  };
}

function sma(values: readonly number[], period: number): IndexedValue[] {
  if (values.length < period) return [];
  const result: IndexedValue[] = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) result.push({ index, value: sum / period });
  }
  return result;
}

function ema(values: readonly number[], period: number): IndexedValue[] {
  if (values.length < period) return [];
  const result: IndexedValue[] = [];
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result.push({ index: period - 1, value: current });
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = values[index]! * multiplier + current * (1 - multiplier);
    result.push({ index, value: current });
  }
  return result;
}

function rsi(values: readonly number[], period: number): IndexedValue[] {
  if (values.length < period + 1) return [];
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change > 0) averageGain += change;
    else averageLoss -= change;
  }
  averageGain /= period;
  averageLoss /= period;
  const result: IndexedValue[] = [{
    index: period,
    value: averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss),
  }];
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result.push({
      index,
      value: averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss),
    });
  }
  return result;
}

function indexedPoints(samples: readonly NumericSample[], values: readonly IndexedValue[]): TimeSeriesPoint[] {
  return values.flatMap(({ index, value }) => {
    const sample = samples[index];
    return sample ? [derivedPoint(sample, value)] : [];
  });
}

function studyPeriod(spec: ChartStudySpec, fallback: number): number {
  return positiveInteger(spec.parameters.period, fallback);
}

function studyWarmupPoints(spec: ChartStudySpec): number {
  if (spec.kind === "sma" || spec.kind === "ema" || spec.kind === "bollinger") {
    return studyPeriod(spec, 20) - 1;
  }
  if (spec.kind === "rsi") return studyPeriod(spec, 14);
  if (spec.kind === "macd") {
    const slow = positiveInteger(spec.parameters.slow, 26);
    const signal = positiveInteger(spec.parameters.signal, 9);
    return slow + signal - 2;
  }
  if (spec.kind === "correlation") return studyPeriod(spec, 20);
  return 0;
}

export function maxStudyWarmupPoints(specs: readonly ChartStudySpec[]): number {
  return Math.max(0, ...specs.filter((spec) => spec.visible !== false).map(studyWarmupPoints));
}

function resolveMovingAverage(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
  exponential: boolean,
): ResolvedSeries[] {
  const period = studyPeriod(spec, 20);
  const samples = samplesFor(input);
  const calculated = exponential
    ? ema(samples.map(({ value }) => value), period)
    : sma(samples.map(({ value }) => value), period);
  const name = exponential ? "EMA" : "SMA";
  return [outputSeries(spec, input, {
    label: `${name}(${period}) ${input.label}`,
    points: indexedPoints(samples, calculated),
    color,
  })];
}

function resolveBollinger(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
): ResolvedSeries[] {
  const period = studyPeriod(spec, 20);
  const deviations = finiteNumber(spec.parameters.stdDev) && spec.parameters.stdDev > 0
    ? spec.parameters.stdDev
    : 2;
  const samples = samplesFor(input);
  const values = samples.map(({ value }) => value);
  const middle = sma(values, period);
  const upper: IndexedValue[] = [];
  const lower: IndexedValue[] = [];
  for (const point of middle) {
    const window = values.slice(point.index - period + 1, point.index + 1);
    const variance = window.reduce((sum, value) => sum + (value - point.value) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * deviations;
    upper.push({ index: point.index, value: point.value + deviation });
    lower.push({ index: point.index, value: point.value - deviation });
  }
  const label = `Bollinger(${period},${deviations}) ${input.label}`;
  return [
    outputSeries(spec, input, {
      id: `${spec.id}:upper`,
      label: `${label} Upper`,
      points: indexedPoints(samples, upper),
      color,
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:middle`,
      label: `${label} Middle`,
      points: indexedPoints(samples, middle),
      color,
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:lower`,
      label: `${label} Lower`,
      points: indexedPoints(samples, lower),
      color,
    }),
  ];
}

function resolveRsi(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const period = studyPeriod(spec, 14);
  const samples = samplesFor(input);
  return [outputSeries(spec, input, {
    label: `RSI(${period}) ${input.label}`,
    points: indexedPoints(samples, rsi(samples.map(({ value }) => value), period)),
    color,
    unit: "index",
    unitGroup: "oscillator-0-100",
    axis: "left",
  })];
}

function resolveMacd(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const fastPeriod = positiveInteger(spec.parameters.fast, 12);
  const slowPeriod = positiveInteger(spec.parameters.slow, 26);
  const signalPeriod = positiveInteger(spec.parameters.signal, 9);
  if (fastPeriod >= slowPeriod) return [];
  const samples = samplesFor(input);
  const values = samples.map(({ value }) => value);
  const fast = new Map(ema(values, fastPeriod).map((point) => [point.index, point.value]));
  const macd = ema(values, slowPeriod).flatMap(({ index, value }) => {
    const fastValue = fast.get(index);
    return fastValue === undefined ? [] : [{ index, value: fastValue - value }];
  });
  const signalOnMacd = ema(macd.map(({ value }) => value), signalPeriod);
  const signal = signalOnMacd.flatMap(({ index, value }) => {
    const source = macd[index];
    return source ? [{ index: source.index, value }] : [];
  });
  const macdByIndex = new Map(macd.map((point) => [point.index, point.value]));
  const histogram = signal.map(({ index, value }) => ({ index, value: macdByIndex.get(index)! - value }));
  const label = `MACD(${fastPeriod},${slowPeriod},${signalPeriod}) ${input.label}`;
  return [
    outputSeries(spec, input, {
      id: `${spec.id}:macd`,
      label,
      points: indexedPoints(samples, macd),
      color,
      axis: "left",
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:signal`,
      label: `${label} Signal`,
      points: indexedPoints(samples, signal),
      color: STUDY_COLORS[1]!,
      axis: "left",
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:histogram`,
      label: `${label} Histogram`,
      points: indexedPoints(samples, histogram),
      color: STUDY_COLORS[4]!,
      style: "columns",
      axis: "left",
    }),
  ];
}

function resolveVolume(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const points = [...input.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => finiteNumber(point.volume)
      ? [derivedPoint({ point, value: point.volume }, point.volume)]
      : []);
  return [outputSeries(spec, input, {
    label: `Volume ${input.label}`,
    points,
    color,
    unit: "shares",
    unitGroup: "volume",
    style: "columns",
    axis: "left",
  })];
}

interface PairedSample {
  point: TimeSeriesPoint;
  left: number;
  right: number;
}

interface SeriesUnit {
  currency: string | null;
  dimension: string;
}

function seriesCurrency(series: ResolvedSeries): string | null {
  const grouped = series.unitGroup.match(/:([A-Z]{3})$/i)?.[1];
  if (grouped) return grouped.toUpperCase();
  if (!/^(?:price|currency-total|per-share)$/.test(series.unitGroup)) return null;
  return series.unit.match(/^([A-Z]{3})(?:$|\/)/i)?.[1]?.toUpperCase() ?? null;
}

function seriesUnit(series: ResolvedSeries): SeriesUnit {
  const currency = seriesCurrency(series);
  const unit = series.unit.trim();
  return {
    currency,
    dimension: currency && unit.toUpperCase().startsWith(currency)
      ? `currency${unit.slice(currency.length).toLowerCase()}`
      : unit.toLowerCase(),
  };
}

function unitFactors(unit: string): { numerator: string[]; denominator: string[] } {
  const [numerator = "", ...denominator] = unit.split("/");
  const factor = (value: string) => {
    const normalized = value.trim();
    if (!normalized || normalized === "1") return [];
    return [normalized.toLowerCase() === "shares" ? "share" : normalized];
  };
  return {
    numerator: factor(numerator),
    denominator: denominator.flatMap(factor),
  };
}

function ratioUnit(left: ResolvedSeries, right: ResolvedSeries): {
  unit: string;
  unitGroup: string;
} {
  const leftFactors = unitFactors(left.unit);
  const rightFactors = unitFactors(right.unit);
  const numerator = [...leftFactors.numerator, ...rightFactors.denominator];
  const denominator = [...leftFactors.denominator, ...rightFactors.numerator];
  for (let index = numerator.length - 1; index >= 0; index -= 1) {
    const match = denominator.findIndex((factor) => (
      factor.toLowerCase() === numerator[index]!.toLowerCase()
    ));
    if (match < 0) continue;
    numerator.splice(index, 1);
    denominator.splice(match, 1);
  }
  const unit = denominator.length === 0
    ? numerator.join("·") || "x"
    : `${numerator.join("·") || "1"}/${denominator.join("·")}`;
  return {
    unit,
    unitGroup: unit === "x" ? "ratio" : `derived-unit:${unit.toLowerCase()}`,
  };
}

function pairedSamples(left: ResolvedSeries, right: ResolvedSeries): PairedSample[] {
  return alignTimeSeries([left, right], {
    mode: "intersection",
    // Formula inputs are point-in-time values, regardless of how either
    // source is drawn. Carry only the latest publicly available observation;
    // alignTimeSeries still gates every value by availableAt.
    carryForward: true,
  }).flatMap((row) => {
    const leftValue = row.values[left.id];
    const rightValue = row.values[right.id];
    if (!finiteNumber(leftValue?.value) || !finiteNumber(rightValue?.value)) return [];
    const availability = Math.max(
      leftValue.point.availableAt?.getTime() ?? leftValue.point.date.getTime(),
      rightValue.point.availableAt?.getTime() ?? rightValue.point.date.getTime(),
    );
    return [{
      left: leftValue.value,
      right: rightValue.value,
      point: {
        date: new Date(row.date),
        observedAt: new Date(row.date),
        availableAt: Number.isFinite(availability) ? new Date(availability) : undefined,
        value: null,
        provenance: { quality: "derived" as const },
      },
    }];
  });
}

function pairedFrequency(left: ResolvedSeries, right: ResolvedSeries): SeriesPeriod {
  return left.nativeFrequency === right.nativeFrequency ? left.nativeFrequency : "auto";
}

function resolvePairStudy(
  spec: ChartStudySpec,
  left: ResolvedSeries,
  right: ResolvedSeries,
  color: string,
): ResolvedSeries[] {
  const paired = pairedSamples(left, right);
  if (spec.kind === "ratio" || spec.kind === "spread") {
    const multiplier = finiteNumber(spec.parameters.multiplier) ? spec.parameters.multiplier : 1;
    const points = paired.map((sample) => derivedPoint(
      { point: sample.point, value: sample.left },
      spec.kind === "ratio"
        ? sample.right === 0 ? null : sample.left / sample.right
        : sample.left - sample.right * multiplier,
    ));
    const ratioStudy = spec.kind === "ratio";
    const outputUnit = ratioStudy
      ? ratioUnit(left, right)
      : { unit: left.unit, unitGroup: left.unitGroup };
    return [outputSeries(spec, left, {
      label: ratioStudy
        ? `${left.label} / ${right.label}`
        : `${left.label} - ${multiplier === 1 ? "" : `${multiplier}×`}${right.label}`,
      points,
      color,
      unit: outputUnit.unit,
      unitGroup: outputUnit.unitGroup,
      // Pair formulas are calculated with as-of carry on the union of both
      // inputs' event dates. Their value is therefore piecewise constant until
      // either input changes, even when an input is displayed as columns.
      style: "step",
      interpolation: "step-after",
      axis: "left",
      nativeFrequency: pairedFrequency(left, right),
    })];
  }

  const period = studyPeriod(spec, 20);
  const useReturns = spec.parameters.returns !== 0;
  const values = useReturns
    ? paired.slice(1).flatMap((sample, index) => {
      const previous = paired[index]!;
      if (previous.left === 0 || previous.right === 0) return [];
      return [{
        point: sample.point,
        left: (sample.left - previous.left) / Math.abs(previous.left),
        right: (sample.right - previous.right) / Math.abs(previous.right),
      }];
    })
    : paired;
  const points: TimeSeriesPoint[] = [];
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const leftMean = window.reduce((sum, item) => sum + item.left, 0) / period;
    const rightMean = window.reduce((sum, item) => sum + item.right, 0) / period;
    let covariance = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (const item of window) {
      const leftDelta = item.left - leftMean;
      const rightDelta = item.right - rightMean;
      covariance += leftDelta * rightDelta;
      leftVariance += leftDelta ** 2;
      rightVariance += rightDelta ** 2;
    }
    const denominator = Math.sqrt(leftVariance * rightVariance);
    const value = denominator === 0 ? null : covariance / denominator;
    points.push(derivedPoint({ point: values[index]!.point, value: values[index]!.left }, value));
  }
  return [outputSeries(spec, left, {
    label: `Correlation(${period}) ${left.label} / ${right.label}`,
    points,
    color,
    unit: "correlation",
    unitGroup: "correlation",
    axis: "left",
    nativeFrequency: pairedFrequency(left, right),
  })];
}

function requiredInputs(kind: ChartStudyKind): number {
  return kind === "ratio" || kind === "spread" || kind === "correlation" ? 2 : 1;
}

/** Base series that must be calculated for currently visible studies. */
export function activeStudyInputSeriesIds(
  studySpecs: readonly ChartStudySpec[],
): Set<string> {
  return new Set(studySpecs
    .filter((spec) => spec.visible !== false)
    .flatMap((spec) => spec.inputSeriesIds));
}

export function resolveStudies(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
): StudyResolutionResult {
  const byId = new Map(baseSeries.map((series) => [series.id, series]));
  const resolved: ResolvedSeries[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  studySpecs.forEach((spec, index) => {
    if (spec.visible === false) return;
    const required = requiredInputs(spec.kind);
    const inputs = spec.inputSeriesIds.map((id) => byId.get(id));
    if (inputs.length !== required || inputs.some((input) => !input)) {
      errors.push(`${spec.id}: ${spec.kind} requires ${required} valid input series.`);
      return;
    }
    const input = inputs[0]!;
    const color = spec.color ?? STUDY_COLORS[index % STUDY_COLORS.length]!;
    let outputs: ResolvedSeries[] = [];
    if (spec.kind === "sma") outputs = resolveMovingAverage(spec, input, color, false);
    else if (spec.kind === "ema") outputs = resolveMovingAverage(spec, input, color, true);
    else if (spec.kind === "bollinger") outputs = resolveBollinger(spec, input, color);
    else if (spec.kind === "rsi") outputs = resolveRsi(spec, input, color);
    else if (spec.kind === "macd") outputs = resolveMacd(spec, input, color);
    else if (spec.kind === "volume") outputs = resolveVolume(spec, input, color);
    else {
      const pairedInput = inputs[1]!;
      const inputUnit = seriesUnit(input);
      const pairedUnit = seriesUnit(pairedInput);
      const sameDimension = inputUnit.dimension === pairedUnit.dimension;
      const differentCurrencies = inputUnit.currency !== null
        && pairedUnit.currency !== null
        && inputUnit.currency !== pairedUnit.currency;
      if (spec.kind === "spread" && !sameDimension) {
        warnings.push(
          `${spec.id}: spread cannot subtract ${pairedInput.unit} from ${input.unit}; choose inputs with matching units.`,
        );
      } else if ((spec.kind === "ratio" || spec.kind === "spread") && differentCurrencies) {
        warnings.push(
          `${spec.id}: ${spec.kind} inputs use different currencies (${inputUnit.currency} and ${pairedUnit.currency}); raw values are not FX-converted.`,
        );
      }
      if (spec.kind === "correlation" && input.nativeFrequency !== pairedInput.nativeFrequency) {
        warnings.push(`${spec.id}: correlation mixes ${input.nativeFrequency} and ${pairedInput.nativeFrequency} observations using as-of alignment.`);
      }
      outputs = resolvePairStudy(spec, input, pairedInput, color);
    }
    if (
      spec.kind !== "volume"
      && (outputs.length === 0 || outputs.every((output) => output.points.length === 0))
    ) {
      warnings.push(`${spec.id}: not enough valid history to calculate ${spec.kind}.`);
    }
    resolved.push(...outputs);
  });
  return { series: resolved, warnings, errors };
}
