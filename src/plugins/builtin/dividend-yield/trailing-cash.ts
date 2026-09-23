import { calendarYearsBefore } from "./calendar";
import type { DividendMetrics, DividendPayment } from "./types";

const DAY = 24 * 60 * 60 * 1000;

type Cadence = NonNullable<DividendMetrics["paymentFrequency"]>;

const REGULAR_CADENCE: Partial<Record<Cadence, { perYear: number; halfPeriodDays: number }>> = {
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
export function inferCadence(payments: readonly DividendPayment[], asOf: Date): Cadence | null {
  const cutoff = calendarYearsBefore(asOf, 2);
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
export function trailingCashAt(payments: readonly DividendPayment[], asOf: Date): number {
  const known = payments.filter((payment) => payment.exDate <= asOf && Number.isFinite(payment.amount) && payment.amount > 0)
    .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
  const cutoff = calendarYearsBefore(asOf, 1);
  const cadence = inferCadence(known, asOf);
  const regular = cadence ? REGULAR_CADENCE[cadence] : undefined;
  if (!regular) return known.filter((payment) => payment.exDate > cutoff).reduce((sum, payment) => sum + payment.amount, 0);

  const halfPeriod = regular.halfPeriodDays * DAY;
  const graceCutoff = new Date(cutoff.getTime() - Math.min(regular.halfPeriodDays, MAX_LATE_GRACE_DAYS) * DAY);
  const candidates = known.filter((payment) => payment.exDate.getTime() > cutoff.getTime() - halfPeriod);
  // Pair each payment with its closest unclaimed counterpart about one year earlier.
  const superseded = new Set<DividendPayment>();
  for (const later of candidates) {
    let best: DividendPayment | null = null;
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
