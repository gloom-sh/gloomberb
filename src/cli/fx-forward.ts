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
  base: Pick<CloudShortRate, "dayCountBasis"> & { value: number },
  quote: Pick<CloudShortRate, "dayCountBasis"> & { value: number; currency: string },
): ImpliedForward {
  const growth = (rate: { value: number; dayCountBasis: number }) => 1 + (rate.value / 100) * days / rate.dayCountBasis;
  const forward = spot * growth(quote) / growth(base);
  const pointSize = forwardPointSize(quote.currency);
  const premiumPercent = (forward / spot - 1) * 100;
  return {
    spot,
    forward,
    points: (forward - spot) / pointSize,
    pointSize,
    premiumPercent,
    annualizedPercent: premiumPercent * 360 / days,
  };
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
export function formatRatePercent(value: number): string {
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

/** `TIIE 28d 6.776% (Banco de México, 2026-10-20; ACT/360)`. */
export function describeShortRate(rate: CloudShortRate & { value: number }): string {
  return `${rate.name} ${formatRatePercent(rate.value)} (${rate.publisher}, ${rate.asOf ?? "undated"}; ACT/${rate.dayCountBasis})`;
}
