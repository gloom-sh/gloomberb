import { publishedWeekClose } from "../analytics/sharpe-cadence";
import { historyStatistics } from "../../../components/chart/curve/model";
import type { CloudPricePointPayload } from "../../../api-client/types";
import { getSectorCollection } from "../sectors/sector-data";
import {
  canonicalExchange,
  normalizeSymbol,
  parsePublicTickerKey,
} from "../../../utils/exchanges";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const ROTATION_LIMIT = 24;
export interface RotationInstrument {
  symbol: string;
  exchange: string;
  label: string;
}
export interface RotationHistory {
  instrument: RotationInstrument;
  currency: string | null;
  points: CloudPricePointPayload[];
  asOf: string | null;
  stale: boolean;
  error: string | null;
}
export interface RotationPoint {
  date: string;
  week: string;
  strength: number | null;
  momentum: number | null;
  relativeReturn13w: number | null;
}
export interface RotationRank {
  percentile: number | null;
  samples: number;
  firstDate: string | null;
  lastDate: string | null;
}
export interface RotationRow {
  id: string;
  label: string;
  symbol: string;
  exchange: string;
  currency: string | null;
  asOf: string | null;
  strength: number | null;
  momentum: number | null;
  quadrant:
    "Leading" | "Weakening" | "Lagging" | "Improving" | "Neutral" | null;
  strengthRank: RotationRank;
  momentumRank: RotationRank;
  relativeReturn13w: number | null;
  trail: RotationPoint[];
  history: RotationPoint[];
  gaps: string[];
}
export interface RotationPayload {
  benchmark: RotationInstrument;
  currency: string | null;
  asOf: string | null;
  fetchedAt: string;
  rows: RotationRow[];
  gaps: string[];
}
export const sectorRotationInstruments = () =>
  getSectorCollection("sectors").items.map((row) => ({
    symbol: row.etf,
    exchange: "NYSEARCA",
    label: row.name,
  }));
export const rotationId = (row: RotationInstrument) =>
  `${canonicalExchange(row.exchange)}:${normalizeSymbol(row.symbol)}`;
export function rotationInstruments(value: string): RotationInstrument[] {
  const symbols = value.split(/[\s,]+/).filter(Boolean);
  const values = [...new Set(symbols.map((value) => value.toUpperCase()))];
  const instruments = values.map((value) => {
    const parsed = parsePublicTickerKey(value);
    if (!/^[A-Z0-9.^=-]{1,20}$/.test(parsed.symbol))
      throw new Error(`Invalid rotation symbol: ${value}`);
    return {
      symbol: parsed.symbol,
      exchange: canonicalExchange(parsed.exchange ?? ""),
      label: parsed.symbol,
    };
  });
  const unique = [
    ...new Map(instruments.map((row) => [rotationId(row), row])).values(),
  ];
  if (unique.length > ROTATION_LIMIT)
    throw new Error(`Choose at most ${ROTATION_LIMIT} instruments.`);
  return unique;
}
export function rotationTrailWeeks(value: unknown): number {
  const weeks = Number(value);
  return Number.isInteger(weeks) && weeks >= 2 && weeks <= 12 ? weeks : 6;
}
function day(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : null;
}
function weekEnd(date: string) {
  const time = Date.parse(date),
    weekday = new Date(time).getUTCDay();
  return new Date(time + ((5 - weekday + 7) % 7) * DAY)
    .toISOString()
    .slice(0, 10);
}
/** A duplicate contradiction is a gap. A correction must be resolved by Cloud. */
export function rotationCloses(
  points: CloudPricePointPayload[],
  through: string,
): Map<string, number> {
  const rows = new Map<string, number>();
  const invalid = new Set<string>();
  for (const point of points) {
    const date = day(point.date);
    if (!date || date > through) continue;
    const weekday = new Date(date).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (
      !Number.isFinite(point.close) ||
      point.close <= 0 ||
      (rows.has(date) && rows.get(date) !== point.close)
    )
      invalid.add(date);
    else rows.set(date, point.close);
  }
  for (const date of invalid) rows.delete(date);
  return rows;
}
export function rotationRank(
  points: RotationPoint[],
  metric: "strength" | "momentum",
  current: number | null,
  through: string | null,
): RotationRank {
  const stats = historyStatistics(
    points.map((point) => ({ date: point.date, value: point[metric] })),
    current,
    { asOf: through ?? "1900-01-01", windowDays: 365 },
  );
  return {
    percentile: stats.count >= 20 ? stats.percentile : null,
    samples: stats.count,
    firstDate: stats.startDate,
    lastDate: stats.endDate,
  };
}
export function rotationQuadrant(
  strength: number | null,
  momentum: number | null,
): RotationRow["quadrant"] {
  if (strength == null || momentum == null) return null;
  if (Math.abs(strength - 100) < 1e-9 || Math.abs(momentum - 100) < 1e-9)
    return "Neutral";
  return strength > 100
    ? momentum > 100
      ? "Leading"
      : "Weakening"
    : momentum > 100
      ? "Improving"
      : "Lagging";
}
export function buildRotation(
  benchmark: RotationHistory,
  instruments: RotationHistory[],
  trailWeeks = 6,
  now = new Date(),
): RotationPayload {
  const today = now.toISOString().slice(0, 10);
  // Exclude the current day and any week whose Friday has not completed.
  const through = new Date(Date.parse(today) - DAY).toISOString().slice(0, 10);
  const reference = rotationCloses(benchmark.points, through);
  const weekly = new Map<string, { date: string; close: number }>();
  for (const [date, close] of [...reference].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const week = weekEnd(date);
    if (week <= through) weekly.set(week, { date, close });
  }
  for (const [week, point] of weekly) {
    if (point.date !== publishedWeekClose(week, benchmark.instrument.exchange))
      weekly.delete(week);
  }
  const weekday = new Date(through).getUTCDay();
  const lastFriday = new Date(
    Date.parse(through) - ((weekday - 5 + 7) % 7) * DAY,
  )
    .toISOString()
    .slice(0, 10);
  const expectedClose = publishedWeekClose(
    lastFriday,
    benchmark.instrument.exchange,
  );
  const end = [...weekly.keys()].at(-1) ?? null;
  const weeks: string[] = [];
  if (end && weekly.size) {
    const start = [...weekly.keys()][0]!;
    for (let time = Date.parse(start); time <= Date.parse(end); time += WEEK)
      weeks.push(new Date(time).toISOString().slice(0, 10));
  }
  const asOf = end ? (weekly.get(end)?.date ?? null) : null;
  const benchmarkGaps = [
    benchmark.error,
    !expectedClose
      ? "Benchmark market calendar is outside published coverage."
      : !weekly.has(lastFriday)
        ? `Benchmark week ending ${lastFriday} is missing its verified ${expectedClose} close.`
        : null,
    benchmark.stale ? "Benchmark history is stale." : null,
    !benchmark.currency ? "Benchmark currency is unavailable." : null,
    asOf && Date.parse(today) - Date.parse(asOf) > 10 * DAY
      ? `Benchmark weekly history ends ${asOf}.`
      : null,
  ].filter((x): x is string => !!x);
  const benchmarkUsable = !!benchmark.currency && !!asOf;
  const rows = instruments.map((source): RotationRow => {
    const closes = rotationCloses(source.points, through);
    const gaps = [
      source.error,
      source.stale ? "History is stale." : null,
      source.currency !== benchmark.currency || !source.currency
        ? "Price currency does not match the benchmark."
        : null,
    ].filter((x): x is string => !!x);
    const ratios = weeks.map((week) => {
      const base = weekly.get(week);
      const close = base ? closes.get(base.date) : null;
      const ratio =
        benchmarkUsable &&
        source.currency === benchmark.currency &&
        base &&
        close != null
          ? close / base.close
          : null;
      return ratio != null && Number.isFinite(ratio) && ratio > 0
        ? ratio
        : null;
    });
    const strengths = ratios.map((ratio, index) => {
      const window = ratios.slice(Math.max(0, index - 12), index + 1);
      if (
        ratio == null ||
        window.length !== 13 ||
        window.some((value) => value == null)
      )
        return null;
      const mean =
        (window as number[]).reduce((sum, value) => sum + value, 0) / 13;
      return (100 * ratio) / mean;
    });
    const history = weeks.map((week, index): RotationPoint => {
      const strength = strengths[index] ?? null,
        previous = index >= 4 ? (strengths[index - 4] ?? null) : null;
      const contiguous =
        index >= 4 &&
        strengths.slice(index - 4, index + 1).every((value) => value != null);
      const priorRatio = index >= 13 ? (ratios[index - 13] ?? null) : null,
        ratio = ratios[index] ?? null;
      return {
        date: weekly.get(week)?.date ?? week,
        week,
        strength,
        momentum:
          strength != null && previous != null && contiguous
            ? (100 * strength) / previous
            : null,
        relativeReturn13w:
          ratio != null &&
          priorRatio != null &&
          ratios.slice(index - 13, index + 1).every((value) => value != null)
            ? 100 * (ratio / priorRatio - 1)
            : null,
      };
    });
    const latest = history.at(-1);
    const usable =
      benchmarkUsable &&
      source.currency === benchmark.currency &&
      latest?.strength != null &&
      Number.isFinite(latest.strength) &&
      latest.momentum != null &&
      Number.isFinite(latest.momentum);
    if (!latest || latest.strength == null || latest.momentum == null)
      gaps.push(
        "At least 17 contiguous matched weekly closes are required; a missing week breaks the trail.",
      );
    const strength = usable ? latest.strength : null,
      momentum = usable ? latest.momentum : null;
    const strengthRank = rotationRank(history, "strength", strength, asOf),
      momentumRank = rotationRank(history, "momentum", momentum, asOf);
    if (usable && (strengthRank.samples < 52 || momentumRank.samples < 52))
      gaps.push(
        "Percentile window has fewer than 52 usable weekly observations.",
      );
    return {
      id: rotationId(source.instrument),
      label: source.instrument.label,
      symbol: source.instrument.symbol,
      exchange: source.instrument.exchange,
      currency: source.currency,
      asOf: usable ? asOf : null,
      strength,
      momentum,
      quadrant: rotationQuadrant(strength, momentum),
      strengthRank,
      momentumRank,
      relativeReturn13w: usable ? latest.relativeReturn13w : null,
      trail: usable ? history.slice(-rotationTrailWeeks(trailWeeks)) : [],
      history,
      gaps,
    };
  });
  return {
    benchmark: benchmark.instrument,
    currency: benchmark.currency,
    asOf: benchmarkUsable ? asOf : null,
    fetchedAt: now.toISOString(),
    rows,
    gaps: benchmarkGaps,
  };
}
