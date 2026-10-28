import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { formatExpDate, formatStrikeLabel } from "../../../utils/options";
import { formatUtcTime } from "../../../utils/utc-time";
import {
  formatModelSpotPrice,
  formatSpotTime,
  modelSpotLabel,
  modelSpotStamp,
  modelSpotStampVariants,
  observedModelSpot,
  type OptionModelSpot,
} from "../options/model-spot";

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
/** What every GEX figure is in, as exports name a unit. */
export const GAMMA_UNIT = "USD per 1% move";

/**
 * The call wall is the strike with the most call gamma in the strikes given
 * (one expiry's or every expiry's), the put wall the strike with the most put
 * gamma. Ties go to the lowest strike; a side with no gamma has no wall.
 */
export function gammaWalls(strikes: readonly { strike: number; calls: number; puts: number }[]): {
  callWall: number | null;
  putWall: number | null;
} {
  let call: { strike: number; size: number } | null = null;
  let put: { strike: number; size: number } | null = null;
  for (const row of strikes.toSorted((left, right) => left.strike - right.strike)) {
    // Puts arrive as a positive amount from the server; a signed one counts by its size.
    const puts = Math.abs(row.puts);
    if (row.calls > 0 && (!call || row.calls > call.size)) call = { strike: row.strike, size: row.calls };
    if (puts > 0 && (!put || puts > put.size)) put = { strike: row.strike, size: puts };
  }
  return { callWall: call?.strike ?? null, putWall: put?.strike ?? null };
}

/**
 * Net dealer gamma of each expiry, from an all-expiries gamma answer. Null
 * when the answer is for one expiry or the server is older than the field.
 */
export function netGammaByExpiry(
  payload: { expiry: string | null; byExpiry?: readonly { expiry: string; net: number }[] } | null | undefined,
): Map<string, number> | null {
  if (!payload || payload.expiry != null || !payload.byExpiry) return null;
  return new Map(payload.byExpiry.map((row) => [row.expiry, row.net]));
}

/**
 * Each expiry's call and put walls, from an all-expiries gamma answer: the
 * strikes of that expiry with the most call and put gamma. Null when the
 * answer is for one expiry or the server is older than the fields.
 */
export function wallsByExpiry(
  payload: { expiry: string | null; byExpiry?: readonly { expiry: string; callWall?: number | null; putWall?: number | null }[] } | null | undefined,
): Map<string, { callWall: number | null; putWall: number | null }> | null {
  if (!payload || payload.expiry != null || !payload.byExpiry?.some((row) => "callWall" in row)) return null;
  return new Map(payload.byExpiry.map((row) => [row.expiry, { callWall: row.callWall ?? null, putWall: row.putWall ?? null }]));
}

const dateSeconds = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
/** Oct 16 '26, as OMON names its expiries. */
export const expiryLabel = (date: string) => formatExpDate(dateSeconds(date));

/** `08:00 UTC`: the time an expiry settles, when the venue states one apart from its day (Deribit); null otherwise. */
export function settlementTime(expiresAt: string | null | undefined): string | null {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at) || at % 86_400_000 === 0) return null;
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** `Oct 30 '26 08:00 UTC` for an expiry with a settlement time, `Oct 30 '26` for one without. */
export function expiryWithTimeLabel(row: { date: string; expiresAt?: string }): string {
  const time = settlementTime(row.expiresAt);
  return time ? `${expiryLabel(row.date)} ${time}` : expiryLabel(row.date);
}

/** Whether open interest counts contracts on a coin (1 BTC each), whose counts run to tenths. */
export const isCoinContract = (contract: { unit: string } | null | undefined) => !!contract && contract.unit !== "shares";

/** A count of contracts: whole for a US listing's, to tenths for a coin's (Deribit's 0.1 BTC step). */
export function formatContracts(value: number | null | undefined, coin: boolean): string {
  if (!coin) return formatCount(value);
  return value == null || !Number.isFinite(value) ? "--" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
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
/** A price level (spot, the gamma flip) written as OMON and OVDV write spot. */
export function formatLevel(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : formatModelSpotPrice(value);
}
/**
 * The spot of a positioning answer as the options panes stamp theirs: the
 * regular session's close when the server says so (a cash index outside its
 * session, which has no extended hours), otherwise the session its time
 * falls in.
 */
function positioningModelSpot(spot: number, at: number, basis?: "close"): OptionModelSpot {
  return basis === "close"
    ? { price: spot, observedAt: at, valuationTime: at, basis: "close", session: null }
    : observedModelSpot(spot, at);
}

/**
 * The spot Gloom Cloud read the distances and dealer gamma at, stamped as
 * every options pane stamps its spot (`modelSpotStamp`), as a stat cell
 * carries it: `pre-market Wed 21 Oct 09:35 UTC`, `close Tue 20 Oct` for an
 * index outside its session, their shorter forms, then none, so the band
 * keeps the columns it has in regular hours. Nothing for the regular
 * session's price.
 */
export function positioningSpotDetail(spot: number | null | undefined, spotAsOf: string | null | undefined, venue?: string, basis?: "close"):
  { detail?: string; detailVariants?: string[] } {
  const at = spotAsOf ? Date.parse(spotAsOf) : Number.NaN;
  if (spot == null || !Number.isFinite(at)) return {};
  // A coin trades around the clock: its spot is the venue's index at a time, with no session.
  if (venue) {
    const time = `${new Date(at).toISOString().slice(11, 16)} UTC`;
    return { detail: `index ${time}`, detailVariants: [`index ${time}`, time, ""] };
  }
  const observed = positioningModelSpot(spot, at, basis);
  const stamp = modelSpotStamp(observed);
  return stamp ? { detail: stamp, detailVariants: [...modelSpotStampVariants(observed), ""] } : {};
}

/** The spot as a report says it: `770.88 pre-market Wed 21 Oct 09:35 UTC`, `770.10 last Wed 21 Oct 14:05 UTC`, `7,722.60 close Tue 27 Oct`. */
export function formatPositioningSpot(spot: number | null | undefined, spotAsOf: string | null | undefined, venue?: string, basis?: "close"): string {
  const at = spotAsOf ? Date.parse(spotAsOf) : Number.NaN;
  if (spot == null || !Number.isFinite(spot)) return "--";
  if (venue) return Number.isFinite(at) ? `${formatLevel(spot)} ${venue} index ${formatUtcTime(new Date(at).toISOString())}` : formatLevel(spot);
  return Number.isFinite(at) ? `${formatLevel(spot)} ${modelSpotLabel(positioningModelSpot(spot, at, basis))}` : formatLevel(spot);
}

const instant = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};
/** `Wed 08:34 UTC`. */
const dayAndTime = (at: number) => formatSpotTime(at).replace(/^(\w{3}) \d{1,2} \w{3} /, "$1 ");
/** `08:34 UTC`. */
const timeOnly = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

/**
 * When dealer gamma is evaluated and when the quotes behind its volatilities
 * were taken, as a report line: `Wed 28 Oct 08:34 UTC, vols from Tue 27 Oct
 * 20:14 UTC`. Before the open that is the pre-market spot's time with the last
 * session's volatilities. Null without a gamma time (an older server, which
 * dates its quotes alone).
 */
export function formatGammaTimes(gammaAsOf: string | null | undefined, quotesAsOf: string | null | undefined): string | null {
  const gamma = instant(gammaAsOf);
  if (gamma == null) return null;
  const quotes = instant(quotesAsOf);
  return quotes == null ? formatSpotTime(gamma) : `${formatSpotTime(gamma)}, vols from ${formatSpotTime(quotes)}`;
}

/**
 * The same as a GEX figure: `Gamma at Wed 08:34 UTC`, detail `vols from Tue
 * 20:14 UTC` (the day left out when it is the gamma's), with shorter forms
 * that keep the quote time. An older server's answer, with no gamma time,
 * dates its quotes alone. Null with neither.
 */
export function gammaTimesFigure(gammaAsOf: string | null | undefined, quotesAsOf: string | null | undefined):
  { label: string; value: string; detail?: string; detailVariants?: string[] } | null {
  const gamma = instant(gammaAsOf);
  const quotes = instant(quotesAsOf);
  if (gamma == null) return quotes == null ? null : { label: "Quotes as of", value: dayAndTime(quotes) };
  if (quotes == null) return { label: "Gamma at", value: dayAndTime(gamma) };
  const sameDay = new Date(gamma).toISOString().slice(0, 10) === new Date(quotes).toISOString().slice(0, 10);
  const quoted = sameDay ? timeOnly(quotes) : dayAndTime(quotes);
  return {
    label: "Gamma at",
    value: dayAndTime(gamma),
    detail: `vols from ${quoted}`,
    detailVariants: [`vols from ${quoted}`, `vols ${quoted}`, `vols ${quoted.replace(/ UTC$/, "")}`],
  };
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

/** Both sides, or blank when either was not reported. A reported zero stays zero. */
export function openInterestTotal(row: { callOI: number | null; putOI: number | null }): number | null {
  if (row.callOI == null || row.putOI == null) return null;
  return row.callOI + row.putOI;
}

/** Strike-chart levels. A missing side is omitted. Puts hang below zero. */
export function strikeChartOpenInterest(row: { callOI: number | null; putOI: number | null }): { call: number | null; put: number | null } {
  return {
    call: row.callOI,
    put: row.putOI == null ? null : -row.putOI,
  };
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

/** Where a chart date made by `toDate` sits across the plot, 0 to 1. */
export const axisRatioOfDate = (date: Date) => date.getTime() / COORDINATE_SPAN;

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
        ticks.push({ label: formatStrikeLabel(Number(value.toFixed(6))), ratio: ratio(value) });
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
