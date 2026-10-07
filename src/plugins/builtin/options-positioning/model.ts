import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { formatExpDate } from "../../../utils/options";

export type PositioningTab = "strikes" | "expiries" | "gex";
export const POSITIONING_TABS: { value: PositioningTab; label: string }[] = [
  { value: "strikes", label: "Strikes" },
  { value: "expiries", label: "Expiries" },
  { value: "gex", label: "GEX" },
];
export const isPositioningTab = (value: unknown): value is PositioningTab =>
  POSITIONING_TABS.some((tab) => tab.value === value);
/** The GEX tab's expiry choice for every expiry at once. */
export const ALL_EXPIRIES = "all";

const dateSeconds = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
/** Oct 16 '26, as OMON names its expiries. */
export const expiryLabel = (date: string) => formatExpDate(dateSeconds(date));

export function formatStrike(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
export function formatCount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : Math.round(value).toLocaleString("en-US");
}
export function formatCountChange(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const rounded = Math.round(value);
  return rounded === 0 ? "0" : `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toLocaleString("en-US")}`;
}
export function formatRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}
export function formatLevel(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}
/** Where a level sits against spot: +0.6%. */
export function formatDistance(level: number | null | undefined, spot: number | null | undefined): string {
  if (level == null || spot == null || !(spot > 0)) return "--";
  const percent = (level / spot - 1) * 100;
  const fixed = Math.abs(percent).toFixed(1);
  return `${/[1-9]/.test(fixed) ? (percent > 0 ? "+" : "-") : ""}${fixed}%`;
}
/** Dollars of dealer delta per 1% move, signed: +1.22B. */
export function formatGamma(value: number | null | undefined): string {
  return value == null ? "--" : formatCompactAmount(value, { signed: true });
}
export function formatPayout(value: number | null | undefined): string {
  return value == null ? "--" : formatCompact(value);
}

/**
 * The strikes a chart keeps: those around spot, out to one and a half times
 * the distance (in log terms) inside which half the weight sits, between 3%
 * and 25%, widened to keep each level given (max pain, the flip) in view.
 * Deep protective puts can hold a large share of an expiry's open interest
 * and would otherwise squeeze the strikes near spot into a few columns.
 * Without spot, the strikes holding the middle 80% of the weight. Rows
 * ascend by strike.
 */
export function chartWindow<T extends { strike: number }>(
  rows: readonly T[],
  weight: (row: T) => number,
  spot: number | null | undefined,
  keep: readonly (number | null | undefined)[] = [],
): T[] {
  const weights = rows.map((row) => Math.max(0, weight(row)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (rows.length <= 4 || !(total > 0)) return [...rows];
  let low: number;
  let high: number;
  if (spot != null && spot > 0) {
    const byDistance = rows
      .map((row, index) => ({ distance: Math.abs(Math.log(row.strike / spot)), weight: weights[index]! }))
      .sort((left, right) => left.distance - right.distance);
    let running = 0;
    const median = byDistance.find((entry) => (running += entry.weight) >= total / 2)?.distance ?? 0;
    const half = Math.min(0.25, Math.max(0.03, 1.5 * median));
    low = rows.findIndex((row) => row.strike >= spot * Math.exp(-half));
    high = rows.findLastIndex((row) => row.strike <= spot * Math.exp(half));
    if (low < 0 || high < low) return [...rows];
  } else {
    const edge = (indexes: number[]) => {
      let running = 0;
      return indexes.find((index) => (running += weights[index]!) >= total * 0.1) ?? indexes.at(-1)!;
    };
    const ascending = rows.map((_, index) => index);
    low = edge(ascending);
    high = edge(ascending.toReversed());
  }
  for (const level of keep) {
    if (level == null || !Number.isFinite(level)) continue;
    while (low > 0 && rows[low]!.strike > level) low -= 1;
    while (high < rows.length - 1 && rows[high]!.strike < level) high += 1;
  }
  return rows.slice(low, high + 1);
}

/** One full-width numeric domain the chart reads as time; strikes are never labelled as dates. */
const COORDINATE_SPAN = 1_000_000_000_000;

export interface NumericAxis {
  /** Where x sits across the plot, 0 at the left edge and 1 at the right. */
  ratio: (x: number) => number;
  toDate: (x: number) => Date;
  /** The strike at a place across the plot. */
  at: (ratio: number) => number;
  /** Round strikes, about one label per eight columns. */
  ticks: (plotWidth: number) => Array<{ label: string; ratio: number }>;
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  // No 2.5 steps: 747.5 reads as a strike on a grid of whole ones.
  return [1, 2, 5, 10].map((multiple) => multiple * magnitude).find((step) => step >= raw) ?? 10 * magnitude;
}

/** A linear strike axis from the lowest strike at the left edge to the highest at the right. */
export function strikeAxis(strikes: readonly number[]): NumericAxis {
  const min = Math.min(...strikes);
  const max = Math.max(...strikes);
  const span = max - min || 1;
  const ratio = (x: number) => (x - min) / span;
  return {
    ratio,
    toDate: (x) => new Date(Math.round(ratio(x) * COORDINATE_SPAN)),
    at: (place) => min + place * span,
    ticks: (plotWidth) => {
      const step = niceStep(span, Math.floor(plotWidth / 8));
      const ticks: Array<{ label: string; ratio: number }> = [];
      for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) {
        ticks.push({ label: formatStrike(Number(value.toFixed(6))), ratio: ratio(value) });
      }
      return ticks;
    },
  };
}

/** Expiries one slot apart, whatever the days between them; labels thin out to fit. */
export function expiryAxis(dates: readonly string[]) {
  const last = Math.max(1, dates.length - 1);
  const index = new Map(dates.map((date, position) => [date, position]));
  const ratio = (date: string) => (index.get(date) ?? 0) / last;
  return {
    ratio,
    toDate: (date: string) => new Date(Math.round(ratio(date) * COORDINATE_SPAN)),
    /** The expiry at a place across the plot. */
    at: (place: number) => dates[Math.max(0, Math.min(dates.length - 1, Math.round(place * last)))] ?? null,
    ticks: (plotWidth: number) => {
      const every = Math.max(1, Math.ceil((dates.length * 11) / Math.max(1, plotWidth)));
      // The year shows once it is not the first expiry's.
      const firstYear = dates[0]?.slice(0, 4);
      return dates.flatMap((date, position) => (position % every === 0
        ? [{ label: date.startsWith(firstYear ?? "") ? expiryLabel(date).replace(/ '\d\d$/, "") : expiryLabel(date), ratio: ratio(date) }]
        : []));
    },
  };
}
