import { scalarPointValue } from "../alignment";
import type { ManualChartResolution } from "../resolution";
import type { StudyBar } from "../trader-studies";
import type {
  ChartStudyKind,
  ChartStudySpec,
  ResolvedSeries,
  SeriesAxis,
  SeriesInterpolation,
  SeriesPeriod,
  SeriesStyle,
  TimeSeriesPoint,
} from "../types";
import { isFiniteNumber } from "../../utils/guards";

export interface NumericSample {
  point: TimeSeriesPoint;
  value: number;
}

export const STUDY_COLORS = ["#f6c85f", "#4dabf7", "#b197fc", "#63e6be", "#ffa94d", "#ff6b6b"];
/**
 * Overlays that sit on the price keep colours of their own, never the blue the
 * first price series takes; the profile is grey so it stays behind the bars.
 */
export const KIND_COLORS: Partial<Record<ChartStudyKind, string>> = {
  vwap: "#ffa94d",
  "anchored-vwap": "#b197fc",
  "volume-profile": "#adb5bd",
  atr: "#63e6be",
  leverage: "#e599f7",
};
/** The decay study's two lines: the fund against the daily line, the daily line against the period multiple. */
export const DECAY_COLORS = ["#ffa94d", "#66d9e8"] as const;
/**
 * One per anchor, so eight lines never repeat a colour. None is red or pink
 * (falling candles take the theme's negative), orange (VWAP), yellow (the
 * first moving average) or blue (the price).
 */
export const ANCHOR_COLORS = ["#b197fc", "#66d9e8", "#8ce99a", "#e599f7", "#9775fa", "#3bc9db", "#c0eb75", "#d0bfff"];

export function positiveInteger(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

export function samplesFor(series: ResolvedSeries): NumericSample[] {
  return [...series.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => {
      const value = scalarPointValue(point);
      return value === null ? [] : [{ point, value }];
    });
}

export function derivedPoint(sample: NumericSample, value: number | null): TimeSeriesPoint {
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

export function outputSeries(
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
    historyResolution?: ManualChartResolution | null;
    /** The unit the legend states; by default the input's, while the output keeps its unit. */
    statedUnit?: string | null;
    /** The kind of price the output is, for its decimals; by default the input's, while the output keeps its unit. */
    priceAssetCategory?: string | null;
    /** The decimals a value worked out from prices prints at. */
    valueDecimals?: number;
  },
): ResolvedSeries {
  const historyResolution = options.historyResolution === undefined ? input.historyResolution : options.historyResolution;
  const sameUnit = (options.unit ?? input.unit) === input.unit && (options.unitGroup ?? input.unitGroup) === input.unitGroup;
  const statedUnit = options.statedUnit === undefined ? sameUnit ? input.statedUnit : undefined : options.statedUnit ?? undefined;
  return {
    id: options.id ?? spec.id,
    label: options.label,
    color: options.color,
    unit: options.unit ?? input.unit,
    unitGroup: options.unitGroup ?? input.unitGroup,
    ...(statedUnit ? { statedUnit } : {}),
    ...(options.valueDecimals !== undefined ? { valueDecimals: options.valueDecimals } : {}),
    priceAssetCategory: options.priceAssetCategory === undefined
      ? sameUnit ? input.priceAssetCategory : undefined
      : options.priceAssetCategory ?? undefined,
    nativeFrequency: options.nativeFrequency ?? input.nativeFrequency,
    ...(historyResolution !== undefined ? { historyResolution } : {}),
    ...(input.historyStart && historyResolution === input.historyResolution ? { historyStart: input.historyStart } : {}),
    ...(input.barSize && historyResolution === input.historyResolution ? { barSize: input.barSize } : {}),
    dataShape: "scalar",
    style: options.style ?? "line",
    transform: "raw",
    axis: spec.axis === "auto" ? options.axis ?? input.axis : spec.axis,
    panelId: spec.panelId,
    interpolation: options.interpolation ?? "none",
    timeBasis: historyResolution === null && input.timeBasis ? { ...input.timeBasis, cadenceMs: undefined } : input.timeBasis,
    observationKind: input.observationKind,
    points: options.points,
  };
}

export function studyPeriod(spec: ChartStudySpec, fallback: number): number {
  return positiveInteger(spec.parameters.period, fallback);
}

/** Bars with a range and volume; a close-only point stands for a bar with no range. */
export function studyBars(input: ResolvedSeries): Array<StudyBar & { sample: NumericSample }> {
  return samplesFor(input).flatMap((sample) => {
    const close = isFiniteNumber(sample.point.close) ? sample.point.close : sample.value;
    const high = isFiniteNumber(sample.point.high) ? sample.point.high : close;
    const low = isFiniteNumber(sample.point.low) ? sample.point.low : close;
    return [{
      time: sample.point.date.getTime(),
      high: Math.max(high, low, close),
      low: Math.min(high, low, close),
      close,
      volume: isFiniteNumber(sample.point.volume) ? sample.point.volume : 0,
      sample,
    }];
  });
}
