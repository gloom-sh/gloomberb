import type { IndicatorDef, SeriesDef } from "./defs";
import type { DatedSeries } from "./series";

export interface ScaledObs {
  date: string;
  value: number;
}

export interface RatioPoint {
  date: string;
  ratio: number;
  /** Present only when both legs are dollar amounts worth showing. */
  numeratorBillions?: number;
  denominatorBillions?: number;
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
      ratio: (point.value / value) * indicator.ratioScale,
      ...(withLevels
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
  if (indicator.input.kind === "direct") {
    const def = indicator.input.series;
    const data = legs.get(def.key);
    if (!data) throw new Error(`missing ${def.key}`);
    const points = scaleObservations(def, data).map((obs) => ({
      date: obs.date,
      ratio: obs.value * indicator.ratioScale,
    }));
    if (points.length === 0) throw new Error("no observations");
    return { indicatorId: indicator.id, points, vintageDate: points.at(-1)!.date };
  }

  const { numerator, denominator, levels } = indicator.input;
  const top = legs.get(numerator.key);
  const bottom = legs.get(denominator.key);
  if (!top || !bottom) throw new Error(`missing ${!top ? numerator.key : denominator.key}`);
  const scaledTop = scaleObservations(numerator, top);
  const scaledBottom = scaleObservations(denominator, bottom);
  const points = alignToDenominator(indicator, scaledTop, scaledBottom, levels != null);
  if (points.length === 0) throw new Error("no overlapping observations");
  return {
    indicatorId: indicator.id,
    points,
    vintageDate: scaledBottom.at(-1)!.date,
  };
}
