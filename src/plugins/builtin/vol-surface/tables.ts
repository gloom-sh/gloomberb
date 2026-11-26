import { MISSING_VALUE } from "../../../utils/format";
import { formatDay } from "../../../utils/day-format";
import { findListedExpiry, settlementStampTime } from "../../../utils/option-expiry";
import { buildSurfaceGrid, evaluateSurfaceSmile, type SurfaceExpiry, type SurfaceGridRow, type SurfaceSnapshot } from "./model";
import { formatModelSpotPrice, modelSpotStamp } from "../options/model-spot";

export const formatIv = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? MISSING_VALUE : `${(value * 100).toFixed(2)}%`;
export const formatPrice = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? MISSING_VALUE : value.toFixed(2);
/**
 * `2027-01-15` for an expiry dated by its day; `2026-10-30 08:00 UTC` for one
 * stamped with the time it settles (Deribit's, at 08:00 UTC): what an export writes.
 */
export const expiryStamp = (expiration: number) => {
  const date = new Date(expiration * 1000).toISOString().slice(0, 10);
  const time = settlementStampTime(expiration);
  return time ? `${date} ${time}` : date;
};
/** An expiry stamp (`expiryStamp`) as tables and text write it, its day first: `30 Oct 2026 08:00 UTC`. */
export const expiryStampText = (stamp: string) => {
  const [day, ...time] = stamp.split(" ");
  return [formatDay(day), ...time].join(" ");
};
/** An expiry as the pane and its text write it: `15 Jan 2027`, `30 Oct 2026 08:00 UTC`. */
export const expiryLabel = (expiration: number) => expiryStampText(expiryStamp(expiration));

/**
 * What a surface that drew some expiries leaves out, in the words a report's
 * and a capture's status name it by, each expiry as --expiration takes it: "4 of 7 expiries ready; empty:
 * 2026-11-27 (no paired two-sided quotes after cleaning), 2026-12-18 (fewer
 * than two cleaned OTM strikes are available)". Each expiry not ready is named
 * with why: its error, else the warning that stopped its fit (the last it
 * took), without the filter counts the Warnings table lists. A ready expiry
 * from a stale chain is named as stale. Null when every expiry asked for is
 * ready.
 */
export function surfaceExpiryGaps(
  expiries: ReadonlyArray<Pick<SurfaceExpiry, "expiration" | "state" | "stale" | "error" | "warnings">>,
  requested = expiries.length,
): string | null {
  const ready = expiries.filter((expiry) => expiry.state === "ready" && !expiry.stale).length;
  const total = Math.max(requested, expiries.length);
  if (ready === total) return null;
  const why = (expiry: (typeof expiries)[number]) => {
    const reason = expiry.error ?? expiry.warnings.at(-1) ?? null;
    const words = reason?.replace(/:.*$/, "").trim();
    if (!words) return "";
    // "No paired ..." reads in the sentence as "no paired ..."; "SVI needs ..." keeps its capitals.
    return ` (${/^[A-Z][a-z]/.test(words) ? `${words[0]!.toLowerCase()}${words.slice(1)}` : words})`;
  };
  const groups: Array<[string, Array<(typeof expiries)[number]>]> = [
    ["empty", expiries.filter((expiry) => expiry.state === "empty")],
    ["failed", expiries.filter((expiry) => expiry.state === "error")],
    ["loading", expiries.filter((expiry) => expiry.state === "loading")],
    ["stale", expiries.filter((expiry) => expiry.state === "ready" && expiry.stale)],
  ];
  const named = groups.filter(([, members]) => members.length > 0).map(([state, members]) =>
    `${state}: ${members.map((expiry) => `${expiryStamp(expiry.expiration)}${state === "stale" || state === "loading" ? "" : why(expiry)}`).join(", ")}`);
  // Expiries asked for that never came back as entries are counted, not named.
  const unread = total - expiries.length;
  return [`${ready} of ${total} expiries ready`, ...named, ...unread > 0 ? [`${unread} not loaded`] : []].join("; ");
}

/** When a surface's expiries settle at a stated time (08:00 UTC), that time, as one note can say it for every expiry. */
export function surfaceSettlementTime(snapshot: Pick<SurfaceSnapshot, "expiries">): string | null {
  for (const expiry of snapshot.expiries) {
    const time = settlementStampTime(expiry.expiration);
    if (time) return time;
  }
  return null;
}

/**
 * The surface's implied volatility at the forward 30 days out, interpolated in
 * total variance between the fitted expiries either side: the point DVOL and
 * IV30 are read against. Null without fitted expiries around it.
 */
export function surfaceThirtyDayAtm(snapshot: SurfaceSnapshot): number | null {
  const grid = buildSurfaceGrid(snapshot, { axis: "forward", tenors: "fixed", coordinates: [1], fixedTenors: [{ label: "30D", years: 30 / 365 }] });
  const row = grid.rows[0];
  return row && !row.extrapolated ? row.cells[0]?.volatility ?? null : null;
}

/**
 * The shared stamp for the spot a surface was fitted at (`modelSpotStamp`):
 * `close Mon 19 Oct` for the official close of the session a closed chain was
 * quoted in, `pre-market Tue 20 Oct 12:21 UTC` for an extended-session print.
 * Null for the regular session's price or a bare spot.
 */
export function surfaceSpotBasisLabel(snapshot: Pick<SurfaceSnapshot, "spotBasis" | "spotAsOf">): string | null {
  const basis = snapshot.spotBasis;
  if (!basis) return null;
  const observedAt = typeof snapshot.spotAsOf === "number" ? snapshot.spotAsOf : Date.parse(String(snapshot.spotAsOf));
  return modelSpotStamp({ basis: basis.basis, session: basis.session, observedAt });
}

/** A one-day front expiry is the noisiest smile on the board; the default selection is the first at least four weeks out. */
const DEFAULT_EXPIRY_MIN_DAYS = 28;
/** Annualising a few days of parity carry produces meaningless yields. */
const DIVIDEND_YIELD_MIN_DAYS = 30;
/**
 * Below this many days to expiry, the ATM term slope to the next expiry
 * annualises a few hours of IV change into hundreds of points a year.
 */
export const TERM_SLOPE_MIN_DAYS = 7;
/** What the Skew view prints in place of a slope it leaves out. */
export const HIDDEN_SLOPE_TEXT = `under ${TERM_SLOPE_MIN_DAYS}d`;
/** What the Forwards view prints in place of a dividend yield it leaves out. */
export const HIDDEN_YIELD_TEXT = `under ${DIVIDEND_YIELD_MIN_DAYS}d`;
/** A decimal IV difference in vol points, as the Skew view prints it. */
export const formatVolPoints = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? MISSING_VALUE : (value * 100).toFixed(2);

/** Calendar days to the expiry's close, as the model prices it. */
const expiryDays = (expiry: Pick<SurfaceExpiry, "years">) => expiry.years * 365;

/**
 * The expiry the smile, chain and pricer actions use: the requested one,
 * matched by calendar date as OMON matches it, else the first at least four
 * weeks out. A requested expiry that is not loaded selects nothing.
 */
export function selectSurfaceExpiry(snapshot: Pick<SurfaceSnapshot, "expiries">, requested: number | null | undefined): SurfaceExpiry | null {
  if (requested != null) {
    const listed = findListedExpiry(requested, snapshot.expiries.map((entry) => entry.expiration));
    return snapshot.expiries.find((entry) => entry.expiration === listed) ?? null;
  }
  return snapshot.expiries.find((entry) => expiryDays(entry) >= DEFAULT_EXPIRY_MIN_DAYS) ?? snapshot.expiries[0] ?? null;
}

/**
 * Why an expiry has no 25-delta risk reversal or butterfly: no fitted smile,
 * or clean quotes that stop short of a 25-delta strike (the fit is never
 * extrapolated past them). Null when both are there, or while it loads.
 */
export function skewGap(expiry: SurfaceExpiry): string | null {
  const { put25, call25, riskReversal, butterfly } = expiry.skew;
  if (riskReversal != null && butterfly != null) return null;
  if (!expiry.fit) return expiry.state === "loading" ? null : "no smile fit";
  if (put25 == null && call25 == null) return "no 25D quotes";
  if (put25 == null) return "no 25D put";
  if (call25 == null) return "no 25D call";
  return "no ATM IV";
}

export interface SurfaceSkewRow {
  expiration: number;
  days: number;
  /** Decimal IVs at the 25-delta put and call. */
  put25: number | null;
  call25: number | null;
  /** Decimal IV differences: call minus put, wing average minus ATM, 90% of spot minus 110%. */
  riskReversal: number | null;
  butterfly: number | null;
  moneynessSkew: number | null;
  /** Decimal ATM IV change per year to the next expiry; null under TERM_SLOPE_MIN_DAYS, which `termSlopeHidden` marks. */
  termSlope: number | null;
  termSlopeHidden: boolean;
  /** Why the risk reversal and butterfly are missing. */
  gap: string | null;
  /** Why the 90/110 figure is missing. */
  moneynessGap: string | null;
}

export function surfaceSkewRow(expiry: SurfaceExpiry): SurfaceSkewRow {
  const days = expiryDays(expiry);
  const termSlopeHidden = expiry.termSlope != null && days < TERM_SLOPE_MIN_DAYS;
  return { expiration: expiry.expiration, days, put25: expiry.skew.put25, call25: expiry.skew.call25,
    riskReversal: expiry.skew.riskReversal, butterfly: expiry.skew.butterfly, moneynessSkew: expiry.skew.moneynessSkew,
    termSlope: termSlopeHidden ? null : expiry.termSlope, termSlopeHidden, gap: skewGap(expiry),
    // 90% and 110% of spot lie past the clean quotes of a near expiry.
    moneynessGap: expiry.skew.moneynessSkew != null ? null : !expiry.fit ? skewGap(expiry) : "not quoted" };
}

export interface SurfaceForwardRow {
  expiration: number;
  forward: number | null;
  /** Forward minus spot, in price. */
  basis: number | null;
  /** Decimal implied dividend yield; null under 30 days out, which `dividendYieldHidden` marks. */
  dividendYield: number | null;
  dividendYieldHidden: boolean;
  rate: number | null;
  /** Put-call pairs behind the forward; a stored close keeps the forward, not its pairs. */
  pairs: number | null;
}

export function surfaceForwardRow(expiry: SurfaceExpiry, snapshot: SurfaceSnapshot & { stored?: unknown }): SurfaceForwardRow {
  const dividendYieldHidden = expiry.dividendYield != null && expiryDays(expiry) < DIVIDEND_YIELD_MIN_DAYS;
  return { expiration: expiry.expiration, forward: expiry.forward, basis: expiry.forward == null ? null : expiry.forward - snapshot.spot,
    dividendYield: dividendYieldHidden ? null : expiry.dividendYield, dividendYieldHidden,
    rate: expiry.rate, pairs: snapshot.stored ? null : expiry.parity.pairs.length };
}

/** A table cell the expiry tables draw: its text, and what an export writes for a day the text puts first. */
export interface SurfaceTableCell { text: string; value?: string }

/**
 * The Skew and Forwards tables: their columns after Expiry, each column's sort
 * value and each cell. Expiry draws `15 Jan 2027` and exports its stamp
 * (`expiryStamp`); the forwards' As of draws its day first and exports its ISO day.
 */
export function surfaceExpiryTable(snapshot: SurfaceSnapshot & { stored?: unknown }, forwards: boolean) {
  // IVs in percent, IV differences in vol points; a missing 25-delta figure says why.
  const fields = forwards ? ["Forward", "Basis", "Div %", "Rate %", "Pairs", "As of"] : ["25d put %", "25d call %", "RR pts", "BF pts", "90/110 pts", "Slope pts/yr"];
  const integerColumn = forwards ? "4" : null;
  const rowsByExpiry = new Map(snapshot.expiries.map((entry) => [entry.expiration,
    { skew: surfaceSkewRow(entry), forward: surfaceForwardRow(entry, snapshot) }]));
  const value = (entry: SurfaceExpiry, id: string): number | string | null => {
    if (id === "expiry") return entry.expiration;
    const { skew, forward } = rowsByExpiry.get(entry.expiration)!;
    return (forwards ? [forward.forward, forward.basis, forward.dividendYield == null ? null : forward.dividendYield * 100,
      forward.rate == null ? null : forward.rate * 100, forward.pairs, entry.asOf?.slice(0, 10) ?? null]
      : [skew.put25, skew.call25, skew.riskReversal, skew.butterfly, skew.moneynessSkew, skew.termSlope])[Number(id)] ?? null;
  };
  const missing = (entry: SurfaceExpiry, id: string) => {
    const { skew, forward } = rowsByExpiry.get(entry.expiration)!;
    if (forwards) return id === "2" && forward.dividendYieldHidden ? HIDDEN_YIELD_TEXT : MISSING_VALUE;
    return (id === "2" || id === "3" ? skew.gap : id === "4" ? skew.moneynessGap : id === "5" && skew.termSlopeHidden ? HIDDEN_SLOPE_TEXT : null) ?? MISSING_VALUE;
  };
  const cell = (entry: SurfaceExpiry, id: string): SurfaceTableCell => {
    if (id === "expiry") return { text: expiryLabel(entry.expiration), value: expiryStamp(entry.expiration) };
    const raw = value(entry, id);
    if (raw == null) return { text: missing(entry, id) };
    if (typeof raw === "string") return { text: formatDay(raw), value: raw };
    return { text: id === integerColumn ? String(raw)
      : forwards ? (id === "0" ? formatModelSpotPrice(raw) : id === "1" && raw > 0 ? `+${formatPrice(raw)}` : formatPrice(raw)) : formatVolPoints(raw) };
  };
  return { fields, value, cell };
}

/** A grid row's Expiry / tenor cell: a listed expiry's day first (`15 Jan 2027 E`), exported as its ISO day (`2027-01-15 E`); a tenor (`1M`) as it is. */
export function surfaceTenorCell(row: Pick<SurfaceGridRow, "label" | "extrapolated" | "interpolated">): SurfaceTableCell {
  const mark = row.extrapolated ? " E" : row.interpolated ? " I" : "";
  return { text: `${formatDay(row.label)}${mark}`, value: `${row.label}${mark}` };
}

/** When and how an expiry's quotes were observed, as a report reads its freshness from each row. */
export const expiryFeedFields = (expiry: SurfaceExpiry) => ({
  asOf: expiry.asOf, dataSource: expiry.dataSource, delayMinutes: expiry.delayMinutes, stale: expiry.stale,
});

/** The Term view's points: ATM at spot and the 25-delta wings, with the expiry's straddle and one-sigma move. */
export function surfaceTermRows(snapshot: SurfaceSnapshot) {
  return snapshot.expiries.filter((expiry) => expiry.atmIV != null).sort((a, b) => a.years - b.years).map((expiry) => ({
    expiration: expiry.expiration, days: expiryDays(expiry), atm: expiry.atmIV, put25: expiry.skew.put25, call25: expiry.skew.call25,
    straddle: expiry.expectedMove.straddle, sigma: expiry.expectedMove.sigma, sigmaPercent: expiry.expectedMove.sigmaPercent,
    ...expiryFeedFields(expiry),
  }));
}

/** The Smile view's clean quotes against the fitted smile, in strike order. */
export function surfaceSmileRows(expiry: SurfaceExpiry) {
  return expiry.points.map((point) => ({ strike: point.strike, side: point.side, moneyness: point.moneyness,
    volatility: point.volatility, fitted: evaluateSurfaceSmile(expiry, point.strike), residual: point.fitResidual,
    mid: point.mid, openInterest: point.openInterest }));
}
