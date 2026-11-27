import type { DividendMetrics, DividendPayment, GrowthPayments } from "./types";
import { MISSING_VALUE, distributionAmountsDigits, formatDistributionAmount } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import { NOT_MEANINGFUL, formatPriceEarnings } from "../../../utils/price-earnings";
import { UNEVEN_REGULAR_PAYMENTS } from "../../../utils/forward-dividend";
import { CADENCE_GRACE_DAYS, LATE_GRACE_DAYS, OFF_CYCLE_DAYS, trailingCashAt, trailingCashInHindsight, type TrailingPayments } from "../../../utils/trailing-dividend";

const DAY = 24 * 60 * 60 * 1000;

/**
 * The decimals a column of amounts shares in each unit it writes them in
 * (dividendAmountDigits): Haier's 0.89151 over 0.26920, never beside 0.2692.
 */
export type DividendAmountDigits = ReadonlyMap<string, number>;

/** The unit an amount is written in and its value there: a converted amount in its history's sub-unit (pence for a London line). */
function shownAmount(value: number, currency: string, subUnit?: string): { value: number; unit: string } {
  const unit = subUnit ? resolveCurrencyUnit(subUnit) : null;
  return unit && unit.divisor !== 1 && unit.currency === currency ? { value: value * unit.divisor, unit: subUnit! } : { value, unit: currency };
}

/** An amount converted from the currency the company declares in, in the unit its history is in (pence for a London line), as any distribution is written. */
export function formatConvertedAmount(value: number | null | undefined, currency: string, subUnit?: string, digits?: DividendAmountDigits): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const shown = shownAmount(value, currency, subUnit);
  return formatDistributionAmount(shown.value, shown.unit, digits?.get(shown.unit));
}

/**
 * The decimals each unit's amounts share down a column of them, from every
 * amount the column holds (distributionAmountsDigits): one precision per
 * column, as the table's other figures keep.
 */
export function dividendAmountDigits(amounts: readonly { amount: number; currency: string }[], converted = false, subUnit?: string): DividendAmountDigits {
  const values = new Map<string, number[]>();
  for (const { amount, currency } of amounts) {
    if (!Number.isFinite(amount) || !currency) continue;
    const shown = converted ? shownAmount(amount, currency, subUnit) : { value: amount, unit: currency };
    values.set(shown.unit, [...values.get(shown.unit) ?? [], shown.value]);
  }
  return new Map([...values].map(([unit, list]) => [unit, distributionAmountsDigits(list, unit)]));
}

export function formatDividendRowAmount(row: Pick<DividendRow, "amount" | "currency" | "cashEstimate" | "combined" | "special">, converted = false, subUnit?: string, digits?: DividendAmountDigits): string {
  const cash = converted ? formatConvertedAmount(row.amount, row.currency, subUnit, digits) : formatDistributionAmount(row.amount, row.currency, digits?.get(row.currency));
  return `${row.cashEstimate ? "estimated " : ""}${row.combined ? `${COMBINED_PAYMENT} ` : ""}${row.special ? `${SPECIAL_PAYMENT} ` : ""}${cash}`;
}

/** A payment its issuer's own form says is a special (DividendPayment.special). */
const SPECIAL_PAYMENT = "special";

/** What the trailing year's specials are, beside its yield: "incl. HK$0.56 special". */
export function trailingSpecialText(metrics: Pick<DividendMetrics, "trailingSpecial">, currency: string): string | null {
  return metrics.trailingSpecial && metrics.trailingSpecial > 0
    ? `incl. ${formatDistributionAmount(metrics.trailingSpecial, currency)} ${SPECIAL_PAYMENT}` : null;
}

/** A row whose amount is a regular payment and an extra one on the same ex-date (DividendPayment.combined). */
export const COMBINED_PAYMENT = "combined";

export function forwardEstimateText(metrics: DividendMetrics): string | null {
  const estimate = metrics.forwardEstimate;
  if (!estimate) return null;
  return `${metrics.forwardBasis === "uneven" ? `${UNEVEN_REGULAR_PAYMENTS}; ` : ""}${cashEstimateText(estimate)}`;
}

function cashEstimateText(estimate: NonNullable<DividendMetrics["forwardEstimate"]>): string {
  const declared = estimate.declaredAmount == null ? estimate.declaredCurrency : `${estimate.declaredAmount} ${estimate.declaredCurrency}/share`;
  return `estimated from ${declared}; FX ${estimate.fixingDate ? `fixing ${estimate.fixingDate}` : "fixing unavailable"}${estimate.basis ? `; ${estimate.basis}` : ""}`;
}

/**
 * What an estimated figure is estimated from, as a report says it once beside the figures it marks: `$0.10 declared,
 * FX fixing 2026-12-07`, the declared amount in the distribution's own formatting, `FX fixing unavailable` while
 * no fixing is known. Each distinct estimate is named once, whichever figures it marks.
 */
export function distinctEstimateTexts(estimates: readonly NonNullable<DividendMetrics["forwardEstimate"]>[]): string[] {
  return [...new Set(estimates.map((estimate) => {
    const declared = estimate.declaredAmount == null ? `declared in ${estimate.declaredCurrency}`
      : `${formatDistributionAmount(estimate.declaredAmount, estimate.declaredCurrency)} declared`;
    return `${declared}, FX ${estimate.fixingDate ? `fixing ${estimate.fixingDate}` : "fixing unavailable"}`;
  }))];
}

/** What a date stated by the company's other listing says beside it: `(from HSBA:LSE)`. */
export const carriedDateText = (listing: string) => `(from ${listing})`;

/** What a converted amount says beside it: `converted from USD`. */
export const convertedFromText = (currency: string) => `converted from ${currency}`;

export function formatDividendYield(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : MISSING_VALUE;
}

/** What the payout ratio is over: trailing twelve-month dividends over this, the EPS the P/E is on. */
export const PAYOUT_BASIS = "TTM diluted EPS";

/** A payout over zero or negative earnings, written as a P/E over a loss is. */
export const PAYOUT_NOT_MEANINGFUL = formatPriceEarnings(NOT_MEANINGFUL);

/** How many payments a trailing yield counts, for a regular payer whose year holds fewer than its cadence pays: "9 of 12 payments". */
export function trailingPaymentsText(payments: TrailingPayments | null | undefined, { cadence = false }: { cadence?: boolean } = {}): string | null {
  return payments ? `${payments.counted} of ${payments.expected} ${cadence ? `${payments.cadence} ` : ""}payments` : null;
}

/** How many payments a growth figure's short year holds: "1 of 2 payments", naming an earlier year by its end. */
export function growthPaymentsDetail(payments: GrowthPayments): string {
  return `${payments.counted} of ${payments.expected} payments${payments.yearTo ? ` in the year to ${payments.yearTo}` : ""}`;
}

/** What a growth figure reads when one of its years is short: "n/a: 1 of 2 payments". */
export function growthPaymentsText(payments: GrowthPayments): string {
  return `n/a: ${growthPaymentsDetail(payments)}`;
}

/** A history served stale, dated by its read when the source gave it. */
export function staleHistoryText(fetchedAt: string | undefined): string {
  const day = fetchedAt && /^\d{4}-\d{2}-\d{2}/.test(fetchedAt) ? fetchedAt.slice(0, 10) : null;
  return `Stale cash history${day ? ` as of ${day}` : ""}; recent distributions may be missing.`;
}

/** Cash history does not contain historical share prices, so cannot establish historical yields. */
export function buildTrailingCashChartPoints(payments: DividendPayment[], now = new Date()): ProjectedChartPoint[] {
  const sorted = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0)
    .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
  const firstDate = sorted[0]?.exDate;
  if (!firstDate) return [];
  // Rolling cash can change on ex-dates, when payments leave the one-year
  // window or its late grace, when the two-year cadence window moves, and
  // when a payment is judged off-cycle.
  // Date rollover deliberately expires February 29 on March 1 in a non-leap
  // year, when the clamped trailing-year cutoff first reaches that payment.
  const dates = new Set<number>([now.getTime()]);
  for (const payment of sorted) {
    dates.add(payment.exDate.getTime());
    // A payment its slot a year on did not repeat stops counting as a period of the cadence (inferCadence).
    const offCycle = payment.exDate.getTime() + OFF_CYCLE_DAYS * DAY;
    if (offCycle <= now.getTime()) dates.add(offCycle);
    for (const years of [1, 2]) {
      const expiry = new Date(payment.exDate);
      expiry.setUTCFullYear(expiry.getUTCFullYear() + years);
      if (expiry <= now) dates.add(expiry.getTime());
      if (years === 1) {
        for (const days of LATE_GRACE_DAYS) {
          const lateExpiry = expiry.getTime() + days * DAY;
          if (lateExpiry <= now.getTime()) dates.add(lateExpiry);
        }
      } else {
        // The cadence's look past two years ends too (inferCadence).
        const cadenceExpiry = expiry.getTime() + CADENCE_GRACE_DAYS * DAY;
        if (cadenceExpiry <= now.getTime()) dates.add(cadenceExpiry);
      }
    }
  }
  const points: ProjectedChartPoint[] = [];
  for (const timestamp of [...dates].sort((a, b) => a - b)) {
    const date = new Date(timestamp);
    // Avoid drawing the first partial year of a fund's history as a full-year cash rate.
    if (calendarMonthsBefore(date, 12) < firstDate) continue;
    // The past reads with what was paid after it; the latest point is as known.
    const cash = timestamp === now.getTime() ? trailingCashAt(sorted, date) : trailingCashInHindsight(sorted, date);
    // A step series only needs its changes and the current value.
    if (points.at(-1)?.close === cash && timestamp !== now.getTime()) continue;
    points.push({ date, open: cash, high: cash, low: cash, close: cash, volume: 0 });
  }
  return points;
}

export interface DividendRow {
  key: string;
  exDate: string;
  amount: number;
  cashEstimate?: DividendPayment["cashEstimate"];
  currency: string;
  /** The amount as the company declared it, in another currency (DividendPayment.declared). */
  declared?: { amount: number; currency: string };
  /** The original publisher when the record cites a notice or sponsor page. */
  source?: string;
  sourceUrl?: string;
  sourceScheduleUrl?: string;
  /** A sourced declaration still owes this distribution (DividendData.declared). */
  pending?: true;
  /** The pay date on record, YYYY-MM-DD: a declaration's, or the one a history record carries. */
  payDate?: string;
  /** A regular payment and an extra one on the same ex-date (DividendPayment.combined). */
  combined?: true;
  /** A special, as the issuer's own form types it (DividendPayment.special). */
  special?: true;
}

/**
 * Where a distribution stands, by the dates on record and never by its place
 * in the history: declared while a declaration still owes it, while its pay
 * date is today or ahead, or before it goes ex; paid once a pay date on record
 * has passed; and ex-dated where the ex-date has passed and no pay date says
 * whether the cash went out.
 */
export function dividendRowStatus(row: Pick<DividendRow, "exDate" | "pending" | "payDate">, today = new Date().toISOString().slice(0, 10)): "Declared" | "Paid" | "Ex-dated" {
  if (row.pending) return "Declared";
  if (row.payDate) return row.payDate < today ? "Paid" : "Declared";
  return row.exDate > today ? "Declared" : "Ex-dated";
}

export function toDividendRows(payments: DividendPayment[]): DividendRow[] {
  return payments.map((payment, index) => ({
    key: `${payment.exDate.toISOString()}:${index}`,
    exDate: payment.exDate.toISOString().slice(0, 10),
    amount: payment.amount,
    ...(payment.cashEstimate ? { cashEstimate: payment.cashEstimate } : {}),
    currency: payment.currency,
    ...(payment.declared ? { declared: payment.declared } : {}),
    ...(payment.source ? { source: payment.source.publisher, sourceUrl: payment.source.url,
      ...(payment.source.scheduleUrl ? { sourceScheduleUrl: payment.source.scheduleUrl } : {}) } : {}),
    ...(payment.combined ? { combined: true as const } : {}),
    ...(payment.special ? { special: true as const } : {}),
  }));
}
