import type { DividendPayment } from "./types";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { calendarYearsBefore } from "./calendar";
import { LATE_GRACE_DAYS, trailingCashAt } from "./trailing-cash";

const DAY = 24 * 60 * 60 * 1000;

export function formatDividendYield(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
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
    if (calendarYearsBefore(date, 1) < firstDate) continue;
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
}

export function toDividendRows(payments: DividendPayment[]): DividendRow[] {
  return payments.map((payment, index) => ({
    key: `${payment.exDate.toISOString()}:${index}`,
    exDate: payment.exDate.toISOString().slice(0, 10),
    amount: payment.amount,
    currency: payment.currency,
  }));
}
