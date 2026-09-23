import { indicatorUnavailableReason, type IndicatorDef, type SeriesDef } from "./defs";
import { validateObservationDates, type DatedSeries } from "./series";

export interface ScaledObs {
  date: string;
  value: number | null;
}

export interface RatioPoint {
  date: string;
  ratio: number | null;
  /** Present only when both legs are dollar amounts worth showing. */
  numeratorBillions?: number;
  denominatorBillions?: number;
}

export function isUsableRatio(point: RatioPoint): point is RatioPoint & { ratio: number } {
  return point.ratio != null && Number.isFinite(point.ratio);
}

export interface ValuationSeries {
  indicatorId: string;
  points: RatioPoint[];
  /** Observation date of the slowest leg, which usually lags the headline value. */
  vintageDate: string;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

/** "2026Q1" style label for the low-frequency leg behind a faster-moving value. */
export function vintageLabel(prefix: string, vintageDate: string): string {
  const d = new Date(parseDateMs(vintageDate));
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${prefix} as of ${d.getUTCFullYear()}Q${quarter}`;
}

/**
 * Shiller's columns publish on different lags: price runs to the current month
 * while dividends and earnings trail it by a quarter or more. A column's blank
 * tail is months not reported yet rather than a gap, so it ends the series at
 * its last reported month. Blanks inside the history stay gaps.
 */
function withoutUnreportedTail<T extends { value: unknown }>(observations: readonly T[]): readonly T[] {
  let end = observations.length;
  while (end > 0 && observations[end - 1]!.value == null) end -= 1;
  return end === observations.length ? observations : observations.slice(0, end);
}

export function scaleObservations(def: SeriesDef, data: DatedSeries): ScaledObs[] {
  if (def.unavailableReason) throw new Error(def.unavailableReason);
  validateObservationDates(data.observations);
  const points: ScaledObs[] = [];
  for (const obs of def.source.kind === "shiller" ? withoutUnreportedTail(data.observations) : data.observations) {
    const scaled = typeof obs.value === "number" ? obs.value * def.scaleToBillions : null;
    points.push({ date: obs.date, value: scaled != null && Number.isFinite(scaled) ? scaled : null });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

/**
 * Carries a low-frequency denominator across the numerator's dates, interpolating
 * between prints and holding the last one flat past the final release.
 */
export function alignToDenominator(
  indicator: IndicatorDef,
  numerator: readonly ScaledObs[],
  denominator: readonly ScaledObs[],
  withLevels: boolean,
): RatioPoint[] {
  if (denominator.length === 0 || numerator.length === 0) return [];
  const firstMs = parseDateMs(denominator[0]!.date);
  const last = denominator[denominator.length - 1]!;
  const lastMs = parseDateMs(last.date);
  const out: RatioPoint[] = [];

  for (const point of numerator) {
    const t = parseDateMs(point.date);
    if (t < firstMs) continue;

    let value: number | null;
    if (t >= lastMs) {
      value = last.value;
    } else {
      let i = 0;
      while (i + 1 < denominator.length && parseDateMs(denominator[i + 1]!.date) <= t) i += 1;
      const left = denominator[i]!;
      const right = denominator[i + 1];
      if (!right || parseDateMs(left.date) === t) {
        value = left.value;
      } else {
        const t0 = parseDateMs(left.date);
        const t1 = parseDateMs(right.date);
        value = left.value == null || right.value == null || left.value <= 0 || right.value <= 0 ? null
          : left.value + ((t - t0) / (t1 - t0)) * (right.value - left.value);
      }
    }
    const ratio = point.value != null && value != null && value > 0
      ? (point.value / value) * indicator.ratioScale : null;
    const usable = ratio != null && Number.isFinite(ratio);
    out.push({
      date: point.date,
      ratio: usable ? ratio : null,
      ...(withLevels && usable && point.value != null && value != null
        ? { numeratorBillions: point.value, denominatorBillions: value }
        : {}),
    });
  }
  return out;
}

export function buildValuationSeries(
  indicator: IndicatorDef,
  legs: ReadonlyMap<string, DatedSeries>,
): ValuationSeries {
  const unavailable = indicatorUnavailableReason(indicator);
  if (unavailable) throw new Error(unavailable);
  if (indicator.input.kind === "direct") {
    const def = indicator.input.series;
    const data = legs.get(def.key);
    if (!data) throw new Error(`missing ${def.key}`);
    const points = scaleObservations(def, data).map((obs) => {
      const ratio = obs.value == null ? null : obs.value * indicator.ratioScale;
      return { date: obs.date, ratio: ratio != null && Number.isFinite(ratio) ? ratio : null };
    });
    if (!points.some(isUsableRatio)) throw new Error("no observations");
    return { indicatorId: indicator.id, points, vintageDate: points.at(-1)!.date };
  }

  const { numerator, denominator, levels } = indicator.input;
  const top = legs.get(numerator.key);
  const bottom = legs.get(denominator.key);
  if (!top || !bottom) throw new Error(`missing ${!top ? numerator.key : denominator.key}`);
  const scaledTop = scaleObservations(numerator, top);
  const scaledBottom = scaleObservations(denominator, bottom);
  const points = alignToDenominator(indicator, scaledTop, scaledBottom, levels != null);
  if (!points.some(isUsableRatio)) throw new Error("no overlapping observations");
  return {
    indicatorId: indicator.id,
    points,
    vintageDate: scaledBottom.at(-1)!.date,
  };
}
