/**
 * The trailing dividend yield, read one way everywhere it shows: `DVD`, its
 * ranking, portfolio income, and a fund's yield in `fundamentals`, `ticker`,
 * the `DES` overview and DIV% (historyTrailingDividendYield).
 * Trailing twelve-month cash per share (trailingCashAt) at its source's
 * precision, over the regular session price in the cash's currency.
 */
import { calendarMonthsBefore } from "./calendar-date";
import { resolveCurrencyUnit } from "./currency-units";
import { atSourcePrecision } from "./dividend-cash";

const DAY = 24 * 60 * 60 * 1000;

/** How often an issuer pays, inferred from its ex-dates (inferCadence). */
export type DistributionCadence = "monthly" | "quarterly" | "semi-annual" | "annual" | "irregular";

/** A paid distribution as the trailing figures read it: its ex-date and its cash per share in the major unit. */
export interface CashDistribution {
  exDate: Date;
  amount: number;
}

const REGULAR_CADENCE: Partial<Record<DistributionCadence, { perYear: number; halfPeriodDays: number }>> = {
  monthly: { perYear: 12, halfPeriodDays: 15 },
  quarterly: { perYear: 4, halfPeriodDays: 45 },
  "semi-annual": { perYear: 2, halfPeriodDays: 91 },
  annual: { perYear: 1, halfPeriodDays: 182 },
};

/** A late payment keeps its prior-year counterpart in the total for at most this long. */
const MAX_LATE_GRACE_DAYS = 30;

/** Days after the one-year expiry at which a late counterpart can still be carried. */
export const LATE_GRACE_DAYS = [...new Set(Object.values(REGULAR_CADENCE)
  .map((cadence) => Math.min(cadence.halfPeriodDays, MAX_LATE_GRACE_DAYS)))];

/** Cadence of ex-dates in the two years ending at `asOf`, ignoring later payments. */
export function inferCadence(payments: readonly Pick<CashDistribution, "exDate">[], asOf: Date): DistributionCadence | null {
  const cutoff = calendarMonthsBefore(asOf, 24);
  // Old suspensions or a former schedule must not redefine a fund's recent cadence.
  const dates = [...new Set(payments.filter((payment) => payment.exDate > cutoff && payment.exDate <= asOf)
    .map((payment) => payment.exDate.getTime()))]
    .sort((a, b) => a - b);
  if (dates.length < 2) return null;
  const avgGapDays = (dates.at(-1)! - dates[0]!) / (dates.length - 1) / DAY;
  if (Math.abs(avgGapDays - 30) < 8) return "monthly";
  if (Math.abs(avgGapDays - 91) < 18) return "quarterly";
  if (Math.abs(avgGapDays - 182) < 36) return "semi-annual";
  if (Math.abs(avgGapDays - 365) < 73) return "annual";
  return "irregular";
}

/**
 * Trailing twelve-month cash as known at `asOf`, one payment per regular period.
 *
 * A fixed one-year ex-date window counts a fifth quarterly (or thirteenth
 * monthly) payment when this year's ex-date is a few days earlier than last
 * year's, and one fewer when it is later. For a regular cadence, a payment is
 * superseded once its counterpart about one year later has gone ex, and a
 * payment just past one year is kept while its counterpart is briefly late and
 * the window holds fewer than one year of payments. Irregular cash uses the
 * plain window, so special distributions are neither dropped nor extended.
 */
export function trailingCashAt<Payment extends CashDistribution>(payments: readonly Payment[], asOf: Date): number {
  const known = payments.filter((payment) => payment.exDate <= asOf && Number.isFinite(payment.amount) && payment.amount > 0)
    .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
  const cutoff = calendarMonthsBefore(asOf, 12);
  const cadence = inferCadence(known, asOf);
  const regular = cadence ? REGULAR_CADENCE[cadence] : undefined;
  if (!regular) return known.filter((payment) => payment.exDate > cutoff).reduce((sum, payment) => sum + payment.amount, 0);

  const halfPeriod = regular.halfPeriodDays * DAY;
  const graceCutoff = new Date(cutoff.getTime() - Math.min(regular.halfPeriodDays, MAX_LATE_GRACE_DAYS) * DAY);
  const candidates = known.filter((payment) => payment.exDate.getTime() > cutoff.getTime() - halfPeriod);
  // Pair each payment with its closest unclaimed counterpart about one year earlier.
  const superseded = new Set<Payment>();
  for (const later of candidates) {
    let best: Payment | null = null;
    let bestDistance = halfPeriod;
    for (const earlier of candidates) {
      if (earlier === later || earlier.exDate >= later.exDate || superseded.has(earlier)) continue;
      const anniversary = new Date(earlier.exDate);
      anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
      const distance = Math.abs(later.exDate.getTime() - anniversary.getTime());
      if (distance < bestDistance) {
        best = earlier;
        bestDistance = distance;
      }
    }
    if (best) superseded.add(best);
  }

  const counted = candidates.filter((payment) => payment.exDate > cutoff && !superseded.has(payment));
  const late = candidates.filter((payment) => payment.exDate <= cutoff && payment.exDate > graceCutoff && !superseded.has(payment))
    .reverse()
    .slice(0, Math.max(0, regular.perYear - counted.length));
  return [...counted, ...late].reduce((sum, payment) => sum + payment.amount, 0);
}

/** A history row as a paid distribution; null when its date is not a calendar day or its amount is no cash. */
export function cashDistribution(exDate: string, amount: number): CashDistribution | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const parsed = new Date(`${exDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== exDate) return null;
  return { exDate: parsed, amount };
}

/** Trailing twelve-month cash per share as known at `now`, at its source's precision (17.8, not 17.799999999999997). */
export function trailingDividendRate(payments: readonly CashDistribution[], now: Date): number {
  const paid = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0);
  return atSourcePrecision(trailingCashAt(paid, now));
}

/** An annual cash rate over the price; null without either. */
export function dividendYieldAt(rate: number | null, price: number | null): number | null {
  return rate != null && Number.isFinite(rate) && price != null && Number.isFinite(price) && price > 0 ? rate / price : null;
}

/** A price in the cash's currency, in its major unit; null when it is quoted in another currency or is no price. */
export function dividendReferencePrice(price: number | null, priceCurrency: string | undefined, cashCurrency: string): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const unit = resolveCurrencyUnit(priceCurrency);
  if (!unit.currency || unit.currency !== resolveCurrencyUnit(cashCurrency).currency) return null;
  return price / unit.divisor;
}

/** The trailing yield: trailing twelve-month cash per share over the price. */
export function trailingDividendYield(payments: readonly CashDistribution[], price: number | null, now: Date): number | null {
  return dividendYieldAt(trailingDividendRate(payments, now), price);
}
