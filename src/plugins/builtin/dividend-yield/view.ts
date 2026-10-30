import type { DividendPayment, GrowthPayments } from "./types";
import { formatCurrency } from "../../../utils/format";
import { currencyMinorDigits } from "../../../market-data/market/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import { NOT_MEANINGFUL, formatPriceEarnings } from "../../../utils/price-earnings";
import { LATE_GRACE_DAYS, trailingCashAt, type TrailingPayments } from "../../../utils/trailing-dividend";

const DAY = 24 * 60 * 60 * 1000;

/**
 * A cash amount the listing pays as a conversion of the currency its company
 * declares in (`DividendData.convertedFrom`), to two decimals of the unit its
 * source states it in: pence stay pence (BP's 6.4059p is `6.41p`, never
 * `£0.06`), and a major unit keeps its currency's decimals (`ZAR 0.87`, not
 * `ZAR 0.866087`), as the conversion gives it no more.
 */
export function formatConvertedAmount(value: number | null | undefined, currency: string, subUnit?: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const unit = subUnit ? resolveCurrencyUnit(subUnit) : null;
  return unit && unit.divisor !== 1 && unit.currency === currency
    ? formatCurrency(value * unit.divisor, subUnit!, 2)
    : formatCurrency(value, currency, currencyMinorDigits(currency));
}

/** What a converted amount says beside it: `converted from USD`. */
export const convertedFromText = (currency: string) => `converted from ${currency}`;

export function formatDividendYield(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
}

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
  // window or its late grace, and when the two-year cadence window moves.
  // Date rollover deliberately expires February 29 on March 1 in a non-leap
  // year, when the clamped trailing-year cutoff first reaches that payment.
  const dates = new Set<number>([now.getTime()]);
  for (const payment of sorted) {
    dates.add(payment.exDate.getTime());
    for (const years of [1, 2]) {
      const expiry = new Date(payment.exDate);
      expiry.setUTCFullYear(expiry.getUTCFullYear() + years);
      if (expiry <= now) dates.add(expiry.getTime());
      if (years === 1) {
        for (const days of LATE_GRACE_DAYS) {
          const lateExpiry = expiry.getTime() + days * DAY;
          if (lateExpiry <= now.getTime()) dates.add(lateExpiry);
        }
      }
    }
  }
  const points: ProjectedChartPoint[] = [];
  for (const timestamp of [...dates].sort((a, b) => a - b)) {
    const date = new Date(timestamp);
    // Avoid drawing the first partial year of a fund's history as a full-year cash rate.
    if (calendarMonthsBefore(date, 12) < firstDate) continue;
    const cash = trailingCashAt(sorted, date);
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
  currency: string;
  /** The amount as the company declared it, in another currency (DividendPayment.declared). */
  declared?: { amount: number; currency: string };
}

export function toDividendRows(payments: DividendPayment[]): DividendRow[] {
  return payments.map((payment, index) => ({
    key: `${payment.exDate.toISOString()}:${index}`,
    exDate: payment.exDate.toISOString().slice(0, 10),
    amount: payment.amount,
    currency: payment.currency,
    ...(payment.declared ? { declared: payment.declared } : {}),
  }));
}
