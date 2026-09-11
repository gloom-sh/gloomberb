import type { DividendPayment } from "./types";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { calendarYearsBefore } from "./calendar";

export function formatDividendYield(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
}

/** Cash history does not contain historical share prices, so cannot establish historical yields. */
export function buildTrailingCashChartPoints(payments: DividendPayment[], now = new Date()): ProjectedChartPoint[] {
  const sorted = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0)
    .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
  const firstDate = sorted[0]?.exDate;
  if (!firstDate) return [];
  // Rolling cash changes both on ex-dates and when payments leave the window.
  // Date rollover deliberately expires February 29 on March 1 in a non-leap
  // year, when the clamped trailing-year cutoff first reaches that payment.
  const dates = new Set<number>([now.getTime()]);
  for (const payment of sorted) {
    dates.add(payment.exDate.getTime());
    const expiry = new Date(payment.exDate);
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
    if (expiry <= now) dates.add(expiry.getTime());
  }
  const points: ProjectedChartPoint[] = [];
  for (const timestamp of [...dates].sort((a, b) => a - b)) {
    const date = new Date(timestamp);
    const cutoff = calendarYearsBefore(date, 1);
    // Avoid drawing the first partial year of a fund's history as a full-year cash rate.
    if (cutoff < firstDate) continue;
    const cash = sorted.filter((p) => p.exDate > cutoff && p.exDate <= date)
      .reduce((sum, p) => sum + p.amount, 0);
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
