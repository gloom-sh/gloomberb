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
  const points: ProjectedChartPoint[] = [];
  for (const payment of sorted) {
    const cutoff = calendarYearsBefore(payment.exDate, 1);
    // Avoid drawing the first partial year of a fund's history as a full-year cash rate.
    if (cutoff < firstDate) continue;
    const cash = sorted.filter((p) => p.exDate > cutoff && p.exDate <= payment.exDate)
      .reduce((sum, p) => sum + p.amount, 0);
    points.push({ date: payment.exDate, open: cash, high: cash, low: cash, close: cash, volume: 0 });
  }
  // A suspended payer still needs a current point: otherwise its chart stops
  // at the final payout and suggests that historical cash rate remains current.
  const currentCutoff = calendarYearsBefore(now, 1);
  if (now > sorted.at(-1)!.exDate && currentCutoff >= firstDate) {
    const cash = sorted.filter((payment) => payment.exDate > currentCutoff).reduce((sum, payment) => sum + payment.amount, 0);
    points.push({ date: now, open: cash, high: cash, low: cash, close: cash, volume: 0 });
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
