import type { AlignmentRuleId, ModeDef, SeriesDef } from "./defs";
import type { DatedSeries } from "./series";

export interface ScaledObs {
  date: string;
  value: number;
}

export interface RatioPoint {
  date: string;
  ratio: number;
  marketCapBillions: number;
  gdpBillions: number;
}

export interface RatioSeries {
  mode: ModeDef["id"];
  resolvedNumeratorId: string;
  points: RatioPoint[];
  gdpVintageDate: string;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

function yearQuarter(date: string): string {
  const ms = parseDateMs(date);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

export function gdpVintageLabel(gdpVintageDate: string): string {
  const ms = parseDateMs(gdpVintageDate);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `GDP as of ${year}Q${quarter}`;
}

function ratioPoint(
  date: string,
  marketCapBillions: number,
  gdpBillions: number,
): RatioPoint {
  return {
    date,
    marketCapBillions,
    gdpBillions,
    ratio: (marketCapBillions / gdpBillions) * 100,
  };
}

export function scaleObservations(
  def: SeriesDef,
  data: DatedSeries,
): ScaledObs[] {
  const points: ScaledObs[] = [];
  for (const obs of data.observations) {
    if (obs.value == null || !Number.isFinite(obs.value)) continue;
    points.push({ date: obs.date, value: obs.value * def.scaleToBillions });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

export function interpolateGdpAligner(
  market: readonly ScaledObs[],
  gdp: readonly ScaledObs[],
): RatioPoint[] {
  if (gdp.length === 0 || market.length === 0) return [];
  const firstGdpMs = parseDateMs(gdp[0]!.date);
  const lastGdp = gdp[gdp.length - 1]!;
  const lastGdpMs = parseDateMs(lastGdp.date);
  const out: RatioPoint[] = [];

  for (const m of market) {
    const t = parseDateMs(m.date);
    if (t < firstGdpMs) continue;

    let gdpValue: number;
    if (t >= lastGdpMs) {
      gdpValue = lastGdp.value;
    } else {
      let i = 0;
      while (i + 1 < gdp.length && parseDateMs(gdp[i + 1]!.date) <= t) i += 1;
      const left = gdp[i]!;
      const right = gdp[i + 1];
      if (!right || parseDateMs(left.date) === t) {
        gdpValue = left.value;
      } else {
        const t0 = parseDateMs(left.date);
        const t1 = parseDateMs(right.date);
        const frac = (t - t0) / (t1 - t0);
        gdpValue = left.value + frac * (right.value - left.value);
      }
    }
    if (!(gdpValue > 0)) continue;
    out.push(ratioPoint(m.date, m.value, gdpValue));
  }
  return out;
}

export function sameQuarterAligner(
  market: readonly ScaledObs[],
  gdp: readonly ScaledObs[],
): RatioPoint[] {
  const gdpByQuarter = new Map<string, number>();
  for (const g of gdp) gdpByQuarter.set(yearQuarter(g.date), g.value);
  const out: RatioPoint[] = [];
  for (const m of market) {
    const gdpValue = gdpByQuarter.get(yearQuarter(m.date));
    if (gdpValue == null || !(gdpValue > 0)) continue;
    out.push(ratioPoint(m.date, m.value, gdpValue));
  }
  return out;
}

const ALIGNERS: {
  readonly [K in AlignmentRuleId]: (
    market: readonly ScaledObs[],
    gdp: readonly ScaledObs[],
  ) => RatioPoint[];
} = {
  "interpolate-gdp": interpolateGdpAligner,
  "same-quarter": sameQuarterAligner,
};

export function buildRatioSeries(
  mode: ModeDef,
  numerator: DatedSeries,
  denominator: DatedSeries,
  resolvedNumeratorId: string,
): RatioSeries {
  const market = scaleObservations(
    { ...mode.numerator, seriesId: resolvedNumeratorId },
    numerator,
  );
  const gdp = scaleObservations(mode.denominator, denominator);
  const points = ALIGNERS[mode.align](market, gdp);
  if (points.length === 0) throw new Error(`${mode.id}: no overlapping observations`);
  return {
    mode: mode.id,
    resolvedNumeratorId,
    points,
    gdpVintageDate: gdp.at(-1)!.date,
  };
}
