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
  /**
   * The issuer's own dividend announcement form says it is a special (Gloom
   * Cloud's `parts` of an HKEX row): it counts in the trailing year, and is no
   * period of the payer's year nor a payment the forward rate reads.
   */
  special?: true;
  /** The issuer's own form says what it is, regular or special: a day of such payments is never read as a one-off by its size. */
  formTyped?: true;
}

/** Whether a payment is a special its issuer's form types (CashDistribution.special). */
const typedSpecial = (payment: { special?: true }) => payment.special === true;

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

/**
 * How far past two years the cadence looks when those two years hold a single ex-date: an annual payer whose
 * ex-date came a few days later than the year before (Moutai's June 25, 2021 and June 30, 2022) has one in
 * them for those days, and read as no cadence its trailing cash fell to nothing until the late one went ex.
 */
export const CADENCE_GRACE_DAYS = MAX_LATE_GRACE_DAYS;

/** A day recurs when one within this many days of a year before paid within RECURRING_BAND of it. */
const SAME_SLOT_DAYS = 45;

/**
 * Days after an ex-date at which it is judged off-cycle when nothing was paid
 * in its slot a year on (offCycleTimes): a year and SAME_SLOT_DAYS.
 */
export const OFF_CYCLE_DAYS = 365.25 + SAME_SLOT_DAYS;

/** Cadence of ex-dates (times, oldest first) in the two years ending at `asOf`. */
function cadenceOf(times: readonly number[], asOf: Date): DistributionCadence | null {
  const cutoff = calendarMonthsBefore(asOf, 24).getTime();
  // Old suspensions or a former schedule must not redefine a fund's recent cadence.
  let dates = times.filter((time) => time > cutoff);
  // A single ex-date in two years: the one before it, if only days past them, says the cadence.
  if (dates.length === 1) dates = times.filter((time) => time > cutoff - CADENCE_GRACE_DAYS * DAY);
  if (dates.length < 2) return null;
  const avgGapDays = (dates.at(-1)! - dates[0]!) / (dates.length - 1) / DAY;
  if (Math.abs(avgGapDays - 30) < 8) return "monthly";
  if (Math.abs(avgGapDays - 91) < 18) return "quarterly";
  if (Math.abs(avgGapDays - 182) < 36) return "semi-annual";
  if (Math.abs(avgGapDays - 365) < 73) return "annual";
  return "irregular";
}

/**
 * The ex-dates (times, oldest first) that recur in no slot of the payer's
 * year: none was paid within SAME_SLOT_DAYS of a year before one, nor of a
 * year after it, and that year after has passed by `asOf` (OFF_CYCLE_DAYS).
 * Each ex-date pairs with at most one a year before and one a year after, the
 * closest pairs first, so an extra beside a regular one does not share its
 * counterpart. WH Group (0288) pays an interim each August or September and a
 * final each May; its HK$0.30 special of 6 October 2025 recurred in no slot,
 * and counted as a period it read the two years to 23 Nov 2026 as quarterly.
 * Gloom Cloud reads the cadence by the same rule (uneven-regular-payments).
 */
function offCycleTimes(times: readonly number[], asOf: Date): Set<number> {
  const at = asOf.getTime();
  // inferCadence's two years and its month further back, and a year and a slot before those for their pairs.
  const read = times.filter((time) => time > at - (731 + CADENCE_GRACE_DAYS + OFF_CYCLE_DAYS) * DAY);
  const pairs: { earlier: number; later: number; distance: number }[] = [];
  for (const [index, earlier] of read.entries()) {
    for (const later of read.slice(index + 1)) {
      const distance = Math.abs((later - earlier) / DAY - 365.25);
      if (distance <= SAME_SLOT_DAYS) pairs.push({ earlier, later, distance });
    }
  }
  const hasLater = new Set<number>();
  const hasEarlier = new Set<number>();
  for (const pair of pairs.sort((left, right) => left.distance - right.distance)) {
    if (hasLater.has(pair.earlier) || hasEarlier.has(pair.later)) continue;
    hasLater.add(pair.earlier);
    hasEarlier.add(pair.later);
  }
  return new Set(read.filter((time) => !hasLater.has(time) && !hasEarlier.has(time) && time + OFF_CYCLE_DAYS * DAY < at));
}

/**
 * Cadence of ex-dates in the two years ending at `asOf`, ignoring later
 * payments, read without those that recurred in no slot of the payer's year
 * (offCycleTimes) where the rest show a regular cadence and the twelve months
 * to `asOf` hold no more ex-dates than it pays: an extra is never a period.
 * Where they show none (a history with a hole, the slots of a schedule that
 * moved), or the year paid more often (Ambev's December, June and September),
 * every ex-date is read.
 */
export function inferCadence(payments: readonly Pick<CashDistribution, "exDate" | "special">[], asOf: Date): DistributionCadence | null {
  // A special its issuer's form types is no period.
  const times = [...new Set(payments.filter((payment) => payment.exDate <= asOf && !typedSpecial(payment)).map((payment) => payment.exDate.getTime()))]
    .sort((a, b) => a - b);
  const offCycle = offCycleTimes(times, asOf);
  const regular = offCycle.size ? cadenceOf(times.filter((time) => !offCycle.has(time)), asOf) : null;
  const perYear = regular ? REGULAR_CADENCE[regular]?.perYear : undefined;
  const yearStart = calendarMonthsBefore(asOf, 12).getTime();
  return perYear && times.filter((time) => time > yearStart).length <= perYear ? regular : cadenceOf(times, asOf);
}

/**
 * The payments trailing twelve-month cash is made of as known at `asOf`, one
 * per regular period, and how many a year the issuer's cadence pays (null
 * without a regular cadence).
 *
 * A fixed one-year ex-date window counts a fifth quarterly (or thirteenth
 * monthly) payment when this year's ex-date is a few days earlier than last
 * year's, and one fewer when it is later. For a regular cadence, a payment is
 * superseded once its counterpart about one year later has gone ex, and a
 * payment just past one year is kept while its counterpart is briefly late and
 * the window holds fewer than one year of payments. Irregular cash uses the
 * plain window, so special distributions are neither dropped nor extended.
 * `stated` is a cadence read for the payer elsewhere (statedCadence).
 */
export function trailingPayments<Payment extends CashDistribution>(payments: readonly Payment[], asOf: Date, stated?: DistributionCadence | null): { counted: Payment[]; perYear: number | null; cadence: DistributionCadence | null } {
  // A special its issuer's form types is no period (trailingCashAt counts it in its year).
  const known = payments.filter((payment) => payment.exDate <= asOf && Number.isFinite(payment.amount) && payment.amount > 0 && !typedSpecial(payment))
    .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
  const cutoff = calendarMonthsBefore(asOf, 12);
  const cadence = stated ?? inferCadence(known, asOf);
  const regular = cadence ? REGULAR_CADENCE[cadence] : undefined;
  if (!regular) return { counted: known.filter((payment) => payment.exDate > cutoff), perYear: null, cadence };

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
  return { counted: [...counted, ...late], perYear: regular.perYear, cadence };
}

/**
 * Trailing twelve-month cash as known at `asOf` (trailingPayments), with the
 * specials the issuer's forms type that went ex in the twelve months
 * (trailingSpecialCash) counted whole.
 */
export function trailingCashAt<Payment extends CashDistribution>(payments: readonly Payment[], asOf: Date): number {
  return trailingPayments(payments, asOf).counted.reduce((sum, payment) => sum + payment.amount, trailingSpecialCash(payments, asOf));
}

/**
 * The specials the issuer's own forms type (CashDistribution.special) that
 * went ex in the twelve months to `asOf`, summed: what the trailing year
 * holds beside its regular payments. Stella's (1836) HK$0.56 of 19 May 2026,
 * paid beside its HK$0.37 final.
 */
export function trailingSpecialCash(payments: readonly CashDistribution[], asOf: Date): number {
  const cutoff = calendarMonthsBefore(asOf, 12);
  return payments.filter((payment) => typedSpecial(payment) && payment.exDate > cutoff && payment.exDate <= asOf
    && Number.isFinite(payment.amount) && payment.amount > 0).reduce((sum, payment) => sum + payment.amount, 0);
}

/**
 * Trailing cash at a past `asOf` read with what came after it: trailingCashAt,
 * plus each payment that has left the trailing year while the payment in its
 * slot a year on had not gone ex yet but did, no later than half a period past
 * the anniversary (SAME_SLOT_DAYS where the payer had no regular cadence).
 * As known on the day, an annual payer's cash fell to nothing for the days its
 * ex-date came later than the year before (Haier's 2019 final, 62 days past
 * the 2018 one's anniversary, past the late grace), and a payer that added an
 * interim read only the interim until its final went ex: a chart of the past
 * has the later payment to say the payer kept paying. A slot nothing filled
 * in time (Haier paid no dividend in 1999) still falls to nothing, a
 * payment whose counterpart a year on already went ex (by trailingPayments'
 * pairing, however early) is never carried beside it, and a typed special is
 * never carried. The latest point is as known: what comes next is not yet
 * paid.
 */
export function trailingCashInHindsight<Payment extends CashDistribution>(payments: readonly Payment[], asOf: Date): number {
  const cash = trailingCashAt(payments, asOf);
  const regular = payments.filter((payment) => Number.isFinite(payment.amount) && payment.amount > 0 && !typedSpecial(payment))
    .sort((left, right) => left.exDate.getTime() - right.exDate.getTime());
  if (!regular.some((payment) => payment.exDate > asOf)) return cash;
  const known = trailingPayments(regular, asOf);
  const counted = new Set(known.counted);
  // How far from its anniversary trailingPayments pairs a payment with the one that supersedes it.
  const pairing = known.cadence ? REGULAR_CADENCE[known.cadence]?.halfPeriodDays : undefined;
  const cutoff = calendarMonthsBefore(asOf, 12);
  // No slot is filled later than an annual payer's half period past its anniversary.
  const earliest = cutoff.getTime() - REGULAR_CADENCE.annual!.halfPeriodDays * DAY;
  let carried = 0;
  for (const payment of regular) {
    if (payment.exDate > cutoff) break;
    if (payment.exDate.getTime() <= earliest || counted.has(payment)) continue;
    const anniversary = new Date(payment.exDate);
    anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
    // Its counterpart already went ex, as trailingPayments pairs them (a final moved weeks earlier): the year holds
    // that one in its place, and carrying this beside it would count the slot twice.
    if (pairing !== undefined && regular.some((other) => other.exDate > payment.exDate && other.exDate <= asOf
      && Math.abs(other.exDate.getTime() - anniversary.getTime()) < pairing * DAY)) continue;
    const next = regular.find((other) => other.exDate.getTime() >= anniversary.getTime() - SAME_SLOT_DAYS * DAY);
    if (!next || next.exDate <= asOf) continue;
    const cadence = inferCadence(regular, payment.exDate) ?? inferCadence(regular, next.exDate);
    const reach = (cadence ? REGULAR_CADENCE[cadence]?.halfPeriodDays : undefined) ?? SAME_SLOT_DAYS;
    if (next.exDate.getTime() <= anniversary.getTime() + reach * DAY) carried += payment.amount;
  }
  return cash + carried;
}

/** How many payments trailing cash counts against how many a year the issuer's cadence pays. */
export interface TrailingPayments {
  counted: number;
  expected: number;
  cadence: DistributionCadence;
}

/**
 * The payments a regular payer's trailing cash counts when it is fewer than
 * its cadence pays in a year: a hole in the history (ECC's monthly July to
 * September 2026 distributions), a missed or late payment, or a fund under a
 * year old. Null for a full year, an irregular payer and an issuer with no
 * cadence, whose trailing cash is the plain window. `stated` is a cadence read
 * for the payer elsewhere (statedCadence).
 */
export function trailingPaymentShortfall(payments: readonly CashDistribution[], asOf: Date, stated?: DistributionCadence | null): TrailingPayments | null {
  const { counted, perYear, cadence } = trailingPayments(payments, asOf, stated);
  return perYear != null && cadence && counted.length < perYear ? { counted: counted.length, expected: perYear, cadence } : null;
}

/** Over this ratio between a regular payer's largest and smallest payment of a year, no one payment stands for the year. */
const UNEVEN_PAYMENT_RATIO = 1.5;

/** A stated rate annualizes a payment when it is that payment times its cadence's count within this share. */
const STATED_TOLERANCE = 0.02;
const STATED_CADENCES = [["annual", 1], ["semi-annual", 2], ["quarterly", 4], ["monthly", 12]] as const;

/**
 * The cadence of a young history, its only two ex-dates in the two years to
 * `asOf`, as a stated forward rate reads it (`stated`: the annual rate and the
 * ex-date of the payment it annualizes): the count it annualizes that payment
 * (or the latest) by, within 2%, or two a year where it is the two payments
 * summed. Two ex-dates show one gap, and an interim four months after a final
 * reads as quarterly: CNGR's H line (2579) paid its 2025 final in June 2026
 * and its 2026 interim in September, 107 days apart. Gloom Cloud serves its
 * rate at the frequency the issuer's Shenzhen line shows, twice the HK$0.44
 * interim. Null for a history with fewer, more or older ex-dates, and for a
 * rate that reads no cadence: inferCadence's gap stands.
 */
export function statedCadence(payments: readonly CashDistribution[], asOf: Date,
  stated: { annualRate: number; exDate: Date | null } | null): DistributionCadence | null {
  if (!stated || !Number.isFinite(stated.annualRate) || !(stated.annualRate > 0)) return null;
  const paid = payments.filter((payment) => payment.exDate <= asOf && Number.isFinite(payment.amount) && payment.amount > 0 && !typedSpecial(payment));
  const cutoff = calendarMonthsBefore(asOf, 24);
  if (paid.some((payment) => payment.exDate <= cutoff)) return null;
  const days = [...new Set(paid.map((payment) => payment.exDate.getTime()))].sort((a, b) => a - b);
  if (days.length !== 2) return null;
  const amountOn = (day: number) => paid.filter((payment) => payment.exDate.getTime() === day).reduce((sum, payment) => sum + payment.amount, 0);
  const annualizes = (amount: number, count: number) => Math.abs(stated.annualRate / (amount * count) - 1) <= STATED_TOLERANCE;
  const dated = stated.exDate && days.includes(stated.exDate.getTime()) ? stated.exDate.getTime() : days[1]!;
  const cadence = STATED_CADENCES.find(([, count]) => annualizes(amountOn(dated), count));
  if (cadence) return cadence[0];
  return annualizes(amountOn(days[0]!) + amountOn(days[1]!), 1) ? "semi-annual" : null;
}

/** Over this ratio, a payer's two payments of a year that differ the same way a year before are uneven too. */
const RECURRING_UNEVEN_RATIO = 1.15;

/**
 * A regular payer's payments of the trailing year when they differ widely:
 * exactly as many as its cadence pays, the largest more than 1.5 times the
 * smallest (HSBC's final beside its interims, AstraZeneca's interim beside its
 * final), or a two-a-year payer's interim and final sized apart the same way
 * each year (recurringUneven: Far East Horizon's). Their total is the year's
 * cash, where the latest one annualized is not (HSBA's interim read as 2.17% a
 * year beside the 4.08% it paid). Null for an even year, one with a hole or an
 * extra payment, an annual payer and an irregular one, and for a year that
 * changed level once and kept it (steppedPayments): a cut or a raise is a new
 * rate, not interims beside a final. `next` is the annual rate of a
 * distribution declared after the year's payments, as the stated forward rate
 * annualizes it. `latest` is the newest payment's ex-date. A one-off special
 * is no regular payment (regularPayments).
 */
export function unevenRegularPayments(payments: readonly CashDistribution[], asOf: Date, next?: { exDate: Date; annualRate: number } | null): { total: number; latest: Date } | null {
  const regular = regularPayments(payments, asOf);
  const { counted, perYear } = trailingPayments(regular, asOf);
  if (perYear == null || perYear < 2 || counted.length !== perYear) return null;
  const ordered = [...counted].sort((left, right) => left.exDate.getTime() - right.exDate.getTime());
  const amounts = ordered.map((payment) => payment.amount);
  if (Math.max(...amounts) <= UNEVEN_PAYMENT_RATIO * Math.min(...amounts) && !recurringUneven(ordered, regular)) return null;
  const latest = ordered.at(-1)!.exDate;
  const declared = next && next.exDate > latest && Number.isFinite(next.annualRate) && next.annualRate > 0 ? next.annualRate / perYear : null;
  if (steppedPayments(ordered, regular, declared)) return null;
  return {
    total: atSourcePrecision(amounts.reduce((sum, amount) => sum + amount, 0)),
    latest,
  };
}

/** A day this many times the median of the days in the REGULAR_LOOKBACK_DAYS before it is a one-off, unless it recurs. */
const SPECIAL_MULTIPLE = 3;
const REGULAR_LOOKBACK_DAYS = 400;
/** A day recurs when one within SAME_SLOT_DAYS of a year before paid within RECURRING_BAND of it. */
const RECURRING_BAND = [2 / 3, 1.5] as const;
/** Rows of one ex-date this close in amount are one row stated twice, not two distributions. */
const SAME_AMOUNT_SHARE = 1e-6;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * The regular distributions paid by `asOf`, one per ex-date (its rows summed,
 * one stated twice counted once), oldest first, without one-offs: a day three
 * times the median of the days in the 400 before it that paid nothing like it
 * a year before. HSBC's final, four and a half times its interims, recurs each
 * March: it is regular. A special its issuer's form types is none, and a day
 * the forms type is never read as a one-off by its size: Stella's (1836)
 * HK$0.37 final of 19 May 2026 is regular beside its HK$0.56 special. Gloom
 * Cloud serves the forward rate by the same rule (its uneven-regular-payments),
 * so DES and DVD agree; keep the two in step.
 */
function regularPayments(payments: readonly CashDistribution[], asOf: Date): CashDistribution[] {
  const byDay = new Map<number, number[]>();
  const typedDays = new Set<number>();
  for (const payment of payments) {
    if (payment.exDate > asOf || !Number.isFinite(payment.amount) || !(payment.amount > 0) || typedSpecial(payment)) continue;
    const day = payment.exDate.getTime();
    byDay.set(day, [...byDay.get(day) ?? [], payment.amount]);
    if (payment.formTyped) typedDays.add(day);
  }
  const days = [...byDay].sort(([left], [right]) => left - right).map(([day, amounts]) => {
    const distinct = [...amounts].sort((left, right) => left - right)
      .filter((amount, index, sorted) => index === 0 || amount - sorted[index - 1]! > SAME_AMOUNT_SHARE * amount);
    return { exDate: new Date(day), amount: distinct.reduce((sum, amount) => sum + amount, 0) };
  });
  const dayOf = (payment: CashDistribution) => payment.exDate.getTime() / DAY;
  const recurs = (payment: CashDistribution) => {
    const slot = days.filter((other) => Math.abs(dayOf(other) - (dayOf(payment) - 365.25)) <= SAME_SLOT_DAYS)
      .reduce((sum, other) => sum + other.amount, 0);
    const ratio = payment.amount / slot;
    return slot > 0 && ratio >= RECURRING_BAND[0] && ratio <= RECURRING_BAND[1];
  };
  return days.filter((payment, index) => {
    if (typedDays.has(payment.exDate.getTime())) return true;
    const before = days.slice(0, index).filter((other) => dayOf(payment) - dayOf(other) <= REGULAR_LOOKBACK_DAYS);
    return !(before.length >= 1 && payment.amount >= SPECIAL_MULTIPLE * median(before.map((other) => other.amount)) && !recurs(payment));
  });
}

/** No payment of `amounts` over 1.5 times another: one level. */
function evenAmounts(amounts: readonly number[]): boolean {
  return Math.max(...amounts) <= UNEVEN_PAYMENT_RATIO * Math.min(...amounts);
}

/**
 * A two-a-year payer's year (oldest first) whose payments differ by over
 * RECURRING_UNEVEN_RATIO, and whose payments a year before (`history`, the
 * closest to each one's anniversary within half a period) differed the same
 * way: the same one larger, by over that ratio too, the four of them rising
 * and falling. An interim and a final the payer sizes apart each year, not a
 * run of raises or cuts: Far East Horizon (3360) paid HK$0.30 in April 2025
 * and HK$0.25 in September, then HK$0.31 in June 2026 and HK$0.25 in
 * September; its HK$0.25 annualized read 10.0% at HK$4.995 on 23 Nov 2026,
 * beside the 11.2% the year paid.
 */
function recurringUneven(year: readonly CashDistribution[], history: readonly CashDistribution[]): boolean {
  const differs = ([first, second]: readonly CashDistribution[]) =>
    Math.max(first!.amount, second!.amount) > RECURRING_UNEVEN_RATIO * Math.min(first!.amount, second!.amount)
      ? first!.amount > second!.amount : null;
  if (year.length !== 2) return false;
  const larger = differs(year);
  if (larger === null) return false;
  const halfPeriod = REGULAR_CADENCE["semi-annual"]!.halfPeriodDays * DAY;
  const [first, second] = year.map((payment) => {
    const anniversary = new Date(payment.exDate);
    anniversary.setUTCFullYear(anniversary.getUTCFullYear() - 1);
    const distance = (earlier: CashDistribution) => Math.abs(earlier.exDate.getTime() - anniversary.getTime());
    return history.filter((earlier) => earlier.exDate < year[0]!.exDate && distance(earlier) <= halfPeriod)
      .sort((left, right) => distance(left) - distance(right))[0];
  });
  if (!first || !second || first.exDate >= second.exDate || differs([first, second]) !== larger) return false;
  // Sized apart, the four rise and fall: four that only rise are raises (Ibiden's 5, 7.5, 7.5 and 10 yen).
  const amounts = [first, second, ...year].map((payment) => payment.amount);
  const steps = amounts.slice(1).map((amount, index) => amount - amounts[index]!);
  return steps.some((step) => step > 0) && steps.some((step) => step < 0);
}

/**
 * A year's payments (`year`, oldest first) that changed level once and kept
 * it: every one before the change at one level, every one after at another,
 * the new level paid at least twice, or once and declared again (`declared`,
 * the next distribution's amount), and not paid in the same periods of the
 * year before, which `history` holds. ECC's $0.14 monthly to March 2026 and
 * $0.06 from April is a cut; HSBC's three interims after a final four times
 * their size are not, being the size of the interims a year earlier, nor is
 * an interim after a final, whose newest level is paid once.
 */
function steppedPayments(year: readonly CashDistribution[], history: readonly CashDistribution[], declared: number | null): boolean {
  const amounts = year.map((payment) => payment.amount);
  const halfPeriod = (year.at(-1)!.exDate.getTime() - year[0]!.exDate.getTime()) / Math.max(1, year.length - 1) / 2;
  for (let change = 1; change < amounts.length; change += 1) {
    const before = amounts.slice(0, change);
    const after = amounts.slice(change);
    if (!evenAmounts(before) || !evenAmounts(after)) continue;
    if (after.length < 2 && (declared == null || !evenAmounts([...after, declared]))) continue;
    const yearEarlier = year.slice(change).flatMap((payment) => {
      const anniversary = new Date(payment.exDate);
      anniversary.setUTCFullYear(anniversary.getUTCFullYear() - 1);
      return history.filter((earlier) => Math.abs(earlier.exDate.getTime() - anniversary.getTime()) <= halfPeriod);
    });
    if (yearEarlier.every((earlier) => !evenAmounts([...after, earlier.amount]))) return true;
  }
  return false;
}

/**
 * The ex-dates (as times) of a monthly or quarterly payer's rows whose one
 * amount is its regular payment and an extra one paid the same day, which a
 * history keyed by ex-date keeps as a single row: ECC's $0.39 of 7 Oct 2022,
 * in October's place between $0.14 months. Such a row falls in its period's
 * place, is over 1.5 times the even payments either side of it, and its period
 * a year before or after is not as large (a final beside interims, as HSBC's,
 * is every year), with at least one of those years in the history.
 */
export function combinedPaymentTimes(payments: readonly CashDistribution[]): Set<number> {
  // A row its issuer's forms split is told apart by them, not guessed.
  const paid = payments.filter((payment) => Number.isFinite(payment.amount) && payment.amount > 0 && !payment.formTyped)
    .sort((left, right) => left.exDate.getTime() - right.exDate.getTime());
  const combined = new Set<number>();
  for (let index = 1; index < paid.length - 1; index += 1) {
    const [previous, current, next] = [paid[index - 1]!, paid[index]!, paid[index + 1]!];
    const cadence = inferCadence(paid, next.exDate);
    if (cadence !== "monthly" && cadence !== "quarterly") continue;
    const period = 2 * REGULAR_CADENCE[cadence]!.halfPeriodDays * DAY;
    const inPlace = (gap: number) => gap >= 0.6 * period && gap <= 1.5 * period;
    if (!inPlace(current.exDate.getTime() - previous.exDate.getTime()) || !inPlace(next.exDate.getTime() - current.exDate.getTime())) continue;
    const regular = Math.max(previous.amount, next.amount);
    if (!evenAmounts([previous.amount, next.amount]) || current.amount <= UNEVEN_PAYMENT_RATIO * regular) continue;
    const counterparts = [-1, 1].flatMap((years) => {
      const anniversary = new Date(current.exDate);
      anniversary.setUTCFullYear(anniversary.getUTCFullYear() + years);
      return paid.filter((payment) => Math.abs(payment.exDate.getTime() - anniversary.getTime()) <= period / 2);
    });
    if (counterparts.length > 0 && counterparts.every((payment) => payment.amount <= UNEVEN_PAYMENT_RATIO * regular)) {
      combined.add(current.exDate.getTime());
    }
  }
  return combined;
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
