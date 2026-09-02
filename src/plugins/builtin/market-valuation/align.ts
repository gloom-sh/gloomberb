import type { IndicatorDef, SeriesDef } from "./defs";
import type { DatedSeries } from "./series";

export interface ScaledObs {
  date: string;
  value: number;
}

export interface RatioPoint {
  date: string;
  ratio: number;
  numeratorBillions: number;
  denominatorBillions: number;
}

export interface RatioSeries {
  indicatorId: string;
  points: RatioPoint[];
  /** Observation date of the last denominator print, which usually lags the numerator. */
  denominatorVintageDate: string;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

/** "2026Q1" style label for the quarterly denominator behind a daily ratio. */
export function vintageLabel(prefix: string, vintageDate: string): string {
  const d = new Date(parseDateMs(vintageDate));
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${prefix} as of ${year}Q${quarter}`;
}

export function scaleObservations(def: SeriesDef, data: DatedSeries): ScaledObs[] {
  const points: ScaledObs[] = [];
  for (const obs of data.observations) {
    if (obs.value == null || !Number.isFinite(obs.value)) continue;
    points.push({ date: obs.date, value: obs.value * def.scaleToBillions });
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
): RatioPoint[] {
  if (denominator.length === 0 || numerator.length === 0) return [];
  const firstMs = parseDateMs(denominator[0]!.date);
  const last = denominator[denominator.length - 1]!;
  const lastMs = parseDateMs(last.date);
  const out: RatioPoint[] = [];

  for (const point of numerator) {
    const t = parseDateMs(point.date);
    if (t < firstMs) continue;

    let value: number;
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
        value = left.value + ((t - t0) / (t1 - t0)) * (right.value - left.value);
      }
    }
    if (!(value > 0)) continue;
    out.push({
      date: point.date,
      numeratorBillions: point.value,
      denominatorBillions: value,
      ratio: (point.value / value) * indicator.ratioScale,
    });
  }
  return out;
}

export function buildRatioSeries(
  indicator: IndicatorDef,
  numerator: DatedSeries,
  denominator: DatedSeries,
): RatioSeries {
  const top = scaleObservations(indicator.numerator, numerator);
  const bottom = scaleObservations(indicator.denominator, denominator);
  const points = alignToDenominator(indicator, top, bottom);
  if (points.length === 0) throw new Error("no overlapping observations");
  return {
    indicatorId: indicator.id,
    points,
    denominatorVintageDate: bottom.at(-1)!.date,
  };
}
