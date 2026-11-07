import type { CloudShortRate } from "../api-client/types";

/**
 * An FX forward implied by covered interest parity: the spot carried by each
 * currency's short rate over the tenor. Not a dealer's quote, and said so
 * wherever it is shown.
 */

/** What every forward says about itself. */
export const IMPLIED_FORWARD_LABEL = "implied by rates, not a dealer quote";

/** The longest tenor offered: past a year the short rates say little about the term rates a forward prices from. */
const MAX_FORWARD_DAYS = 366;
const DAY_MS = 86_400_000;

export interface ForwardTenor {
  /** As typed, normalised: `30d`, `3m`. */
  label: string;
  /** Calendar days from today to the forward date. */
  days: number;
}

/**
 * A tenor as days (`30d`), weeks (`4w`), months (`3m`) or years (`1y`). Months
 * and years count calendar days from `today` to the same day that many months
 * on (the month's last day when it has no such day), as a dated forward runs.
 */
export function parseForwardTenor(text: string, today: Date = new Date()): ForwardTenor | { error: string } {
  const match = /^\s*(\d{1,3})\s*([dwmy])\s*$/i.exec(text);
  if (!match) return { error: `"${text}" is not a tenor; write it as days, weeks, months or years, such as 30d, 2w, 3m or 1y.` };
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (count <= 0) return { error: "A forward tenor is at least one day." };
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let days: number;
  if (unit === "d") days = count;
  else if (unit === "w") days = count * 7;
  else {
    const months = unit === "m" ? count : count * 12;
    const target = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(today.getUTCDate(), lastDay));
    days = Math.round((target.getTime() - start) / DAY_MS);
  }
  if (days > MAX_FORWARD_DAYS) return { error: "Forwards run to 1y: past a year, short rates say little about the term rates a forward prices from." };
  return { label: `${count}${unit}`, days };
}

/** The size of one forward point: a pip, 0.01 for a pair quoted in yen and 0.0001 otherwise. */
export function forwardPointSize(quoteCurrency: string): number {
  return quoteCurrency === "JPY" ? 0.01 : 0.0001;
}

export interface ImpliedForward {
  spot: number;
  forward: number;
  /** Forward less spot, in points of `pointSize`. */
  points: number;
  pointSize: number;
  /** The forward's premium (positive) or discount over spot across the tenor, percent. */
  premiumPercent: number;
  /** The same premium a year: `premiumPercent` × 360 / days. */
  annualizedPercent: number;
  /** What one unit of the base and of the quote currency grows to over the tenor at its own rate. */
  baseGrowth: number;
  quoteGrowth: number;
}

/**
 * Covered interest parity for BASE/QUOTE (`spot` QUOTE per BASE): money in
 * either currency earns its own rate as simple interest over `days` on its
 * day count, so F = S × (1 + r_quote × d / basis_quote) / (1 + r_base × d / basis_base).
 * Rates are percent a year.
 */
export function impliedForward(
  spot: number,
  days: number,
  base: Pick<CloudShortRate, "dayCountBasis" | "compounding"> & { value: number },
  quote: Pick<CloudShortRate, "dayCountBasis" | "compounding"> & { value: number; currency: string },
): ImpliedForward {
  const baseGrowth = shortRateGrowth(base, days);
  const quoteGrowth = shortRateGrowth(quote, days);
  const forward = spot * quoteGrowth / baseGrowth;
  const pointSize = forwardPointSize(quote.currency);
  const premiumPercent = (forward / spot - 1) * 100;
  return {
    spot,
    forward,
    points: (forward - spot) / pointSize,
    pointSize,
    premiumPercent,
    annualizedPercent: premiumPercent * 360 / days,
    baseGrowth,
    quoteGrowth,
  };
}

/**
 * What one unit grows to over `days` at a short rate: simple interest on its
 * day count; for a rate compounded over 252 business days (CDI),
 * (1 + r)^(days / 365), business days taken as 252/365 of the calendar days;
 * for one compounded daily on ACT/365 (ZARONIA), (1 + r / 365)^days.
 */
function shortRateGrowth(rate: Pick<CloudShortRate, "dayCountBasis" | "compounding"> & { value: number }, days: number): number {
  if (rate.compounding === "business-252") return (1 + rate.value / 100) ** (days / 365);
  if (rate.compounding === "daily-365") return (1 + rate.value / 100 / 365) ** days;
  return 1 + (rate.value / 100) * days / rate.dayCountBasis;
}

/**
 * `(1 + 3.92% × 92/360)`, `(1 + 13.65%)^(92/365)` for a rate compounded over
 * business days, `(1 + 7.099%/365)^92` for one compounded daily: one leg of
 * the parity, as `fx --forward` prints it.
 */
export function shortRateGrowthText(rate: Pick<CloudShortRate, "dayCountBasis" | "compounding"> & { value: number }, days: number): string {
  if (rate.compounding === "business-252") return `(1 + ${formatRatePercent(rate.value)})^(${days}/365)`;
  if (rate.compounding === "daily-365") return `(1 + ${formatRatePercent(rate.value)}/365)^${days}`;
  return `(1 + ${formatRatePercent(rate.value)} × ${days}/${rate.dayCountBasis})`;
}

/** A rate the forward can use: listed for the currency, with a value. */
export type ShortRateLookup = { rate: CloudShortRate & { value: number } } | { error: string };

/**
 * The currency's short rate, or the sentence naming which rate is missing
 * and why: none served for the currency, or the one served not read.
 */
export function shortRateFor(currency: string, rates: readonly CloudShortRate[]): ShortRateLookup {
  const rate = rates.find((candidate) => candidate.currency === currency);
  if (!rate) {
    const served = [...new Set(rates.map((candidate) => candidate.currency))].sort();
    return { error: `No short rate for ${currency}${served.length > 0 ? `; forwards are implied for ${served.join(", ")}` : ""}.` };
  }
  if (rate.value == null || !Number.isFinite(rate.value)) {
    return { error: `${rate.name} (${currency}) could not be read${rate.unavailableReason ? `: ${rate.unavailableReason}` : ""}.` };
  }
  return { rate: rate as CloudShortRate & { value: number } };
}

/** `6.776%`: a rate as its publisher prints it, to four decimals at most. */
function formatRatePercent(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

/** `+0.2416%`, signed, to four decimals. */
export function formatSignedPercent(value: number, decimals = 4): string {
  const fixed = value.toFixed(decimals);
  return `${value >= 0 ? "+" : ""}${fixed}%`;
}

/** Forward points to a tenth of a point, signed: `+430.6`. */
export function formatForwardPoints(points: number): string {
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)}`;
}

/**
 * `TIIE 28d 6.776% (Banco de México, 2026-10-20; ACT/360)`, `CDI 13.65% (Banco Central do Brasil, 2026-11-05; BUS/252 compounded)`,
 * `ZARONIA 7.099% (South African Reserve Bank, 2026-11-05; ACT/365 compounded daily)`.
 */
export function describeShortRate(rate: CloudShortRate & { value: number }): string {
  const basis = rate.compounding === "business-252" ? "BUS/252 compounded"
    : rate.compounding === "daily-365" ? "ACT/365 compounded daily" : `ACT/${rate.dayCountBasis}`;
  return `${rate.name} ${formatRatePercent(rate.value)} (${rate.publisher}, ${rate.asOf ?? "undated"}; ${basis})`;
}

/**
 * The carry of a forward on an amount of the pair's base currency, above
 * zero: the forward points on it over the tenor, in the quote currency. The
 * side that holds the currency whose rate earns more over the tenor (the
 * larger growth factor) earns it: with the forward above spot, the seller of
 * the base currency forward (short the pair); below spot, the buyer (long).
 * A forward at spot has no carry.
 */
export interface ForwardCarry {
  /** The amount, in the pair's base currency. */
  amount: number;
  /** Amount × |forward - spot|, in the quote currency: what one side pays the other. */
  value: number;
  /** The side that earns it; null when the forward is at spot. */
  earnedBy: "long" | "short" | null;
  /** The currency whose rate earns more over the tenor, from the two growth factors; null when they are equal. */
  higher: "base" | "quote" | null;
}

export function forwardCarry(
  amount: number,
  implied: Pick<ImpliedForward, "spot" | "forward" | "baseGrowth" | "quoteGrowth">,
): ForwardCarry {
  const difference = implied.forward - implied.spot;
  return {
    amount,
    value: Math.abs(amount * difference),
    earnedBy: difference > 0 ? "short" : difference < 0 ? "long" : null,
    higher: implied.quoteGrowth > implied.baseGrowth ? "quote" : implied.quoteGrowth < implied.baseGrowth ? "base" : null,
  };
}

/**
 * Who earns the carry and who pays it, by side of the pair: `Short USD/MXN
 * (selling USD forward) earns it and long USD/MXN (buying USD forward) pays
 * it: MXN's rate earns more over the 30 days.` A forward at spot has none.
 */
export function describeCarrySides(carry: ForwardCarry, base: string, quote: string, days: number): string {
  if (carry.earnedBy == null || carry.higher == null) {
    return `No carry: at these rates ${base} and ${quote} earn the same over the ${days} days, so the forward is at spot.`;
  }
  const short = `short ${base}/${quote} (selling ${base} forward)`;
  const long = `long ${base}/${quote} (buying ${base} forward)`;
  const [earns, pays] = carry.earnedBy === "short" ? [short, long] : [long, short];
  const higher = carry.higher === "quote" ? quote : base;
  return `${earns.charAt(0).toUpperCase()}${earns.slice(1)} earns it and ${pays} pays it: ${higher}'s rate earns more over the ${days} days.`;
}
