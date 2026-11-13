import type { Fundamentals, TickerFinancials } from "../types/financials";
import { areNearbyFinancialPeriodEnds } from "./financial-statements";
import { latestFinancialPeriod } from "./latest-financial-period";

/** The margins and growth rates the source serves with a company's fundamentals. */
export type ServedRate = "operatingMargin" | "profitMargin" | "revenueGrowth" | "lastQuarterGrowth";

const finiteNumber = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

/**
 * Why the served revenue growth is N/M: the period it is measured against, a year before the
 * latest quarter or half, had revenue at or below zero. Null where it is a number or the base
 * is not on file.
 */
function revenueGrowthNotMeaningful(financials: Pick<TickerFinancials, "quarterlyStatements"> | null | undefined): string | null {
  const periods = (financials?.quarterlyStatements ?? []).filter((row) => finiteNumber(row.totalRevenue));
  const latest = latestFinancialPeriod(periods, (row) => row.date);
  if (!latest) return null;
  const yearBefore = `${Number(latest.date.slice(0, 4)) - 1}${latest.date.slice(4, 10)}`;
  const base = periods.find((row) => areNearbyFinancialPeriodEnds(row.date.slice(0, 10), yearBefore));
  return base && base.totalRevenue! <= 0 ? `revenue to ${base.date.slice(0, 10)} is at or below zero` : null;
}

/**
 * Why each margin or revenue growth the source served is N/M, as RV, DES and `ticker` read them
 * (utils/growth): a margin over trailing revenue at or below zero, and growth off revenue at or
 * below zero a year before the latest quarter or half. A served figure is a number that says
 * nothing there: a loss over negative revenue reads as a profit margin. Empty where each is a number.
 */
export function servedRatesNotMeaningful(
  fundamentals: Pick<Fundamentals, "revenue"> | null | undefined,
  financials: Pick<TickerFinancials, "quarterlyStatements"> | null | undefined,
): Partial<Record<ServedRate, string>> {
  const reasons: Partial<Record<ServedRate, string>> = {};
  if (finiteNumber(fundamentals?.revenue) && fundamentals.revenue <= 0) {
    reasons.operatingMargin = "trailing revenue is at or below zero";
    reasons.profitMargin = "trailing revenue is at or below zero";
  }
  const growth = revenueGrowthNotMeaningful(financials);
  if (growth) {
    reasons.revenueGrowth = growth;
    reasons.lastQuarterGrowth = growth;
  }
  return reasons;
}
