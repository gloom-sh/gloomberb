import { formatCompactAxis, spanAxisFormatter } from "../../../components/chart-table/axis";
import type { CompositeAxisValueFormatter } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";
import { formatCompact } from "../../../utils/format";
import type { ParsedInsiderFiling } from "./model";

/** One week of open-market trades, Monday to Sunday by trade date, in shares; plan trades apart. */
export interface InsiderWeek {
  /** The week's Monday, YYYY-MM-DD in UTC. */
  start: string;
  buys: number;
  planBuys: number;
  sales: number;
  planSales: number;
}

const DAY_MS = 86_400_000;

/** A date as it arrives: a Date here, an ISO string once it has crossed a JSON boundary (a saved copy, the desktop and web bridge). */
const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

function weekStart(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The filings' open-market buys and sales (codes P and S) of shares, not
 * derivatives, by the week they traded, oldest first. A trade on a form with
 * the Rule 10b5-1 box checked counts as a plan trade. Lines are taken as the
 * 90-day totals above the chart take them, so the bars add up to them; with
 * `since`, only trades from then on.
 */
export function insiderWeeklyActivity(parsed: readonly ParsedInsiderFiling[], since = Number.NEGATIVE_INFINITY): InsiderWeek[] {
  const weeks = new Map<string, InsiderWeek>();
  for (const { transaction } of parsed) {
    if (!transaction || transaction.isDerivative || transaction.shares == null || !transaction.filingDate) continue;
    if (transaction.transactionType !== "P" && transaction.transactionType !== "S") continue;
    const traded = toDate(transaction.filingDate);
    const time = traded.getTime();
    if (!Number.isFinite(time) || time < since) continue;
    const start = weekStart(traded);
    const week = weeks.get(start) ?? { start, buys: 0, planBuys: 0, sales: 0, planSales: 0 };
    const plan = transaction.rule10b51 === true;
    if (transaction.transactionType === "P") week[plan ? "planBuys" : "buys"] += transaction.shares;
    else week[plan ? "planSales" : "sales"] += transaction.shares;
    weeks.set(start, week);
  }
  return [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * How much of the shown open-market selling (or buying, `side`) was under a
 * plan, in shares: said once above the table instead of on every row.
 */
export function insiderPlanShare(weeks: readonly InsiderWeek[], side: "buy" | "sell"): { plan: number; total: number } {
  let plan = 0;
  let total = 0;
  for (const week of weeks) {
    const [own, planned] = side === "buy" ? [week.buys, week.planBuys] : [week.sales, week.planSales];
    plan += planned;
    total += own + planned;
  }
  return { plan, total };
}

const SHARES = "insider-shares";
const PRICE = "insider-price";

export interface InsiderChartPalette {
  buy: string;
  planBuy: string;
  sell: string;
  planSell: string;
  price: string;
}

/**
 * The chart over INS's trades: each week's shares bought above zero and sold
 * below it, plan trades in their own muted bars, against the daily close on
 * an axis of its own from the first week shown. Empty when there is no
 * open-market trade, or only one week of them and no price to set it against.
 */
export function insiderActivitySeries(weeks: readonly InsiderWeek[], prices: readonly PricePoint[] | null, palette: InsiderChartPalette): ResolvedSeries[] {
  if (weeks.length === 0) return [];
  const first = Date.parse(`${weeks[0]!.start}T00:00:00Z`);
  const closes = (prices ?? []).map((point) => ({ date: toDate(point.date), close: point.close }))
    .filter((point) => point.date.getTime() >= first && Number.isFinite(point.close));
  if (weeks.length < 2 && closes.length < 2) return [];
  const at = (week: InsiderWeek) => new Date(`${week.start}T00:00:00Z`);
  // Every week from the first trade to the latest close, a quiet one at zero,
  // so each bar is a week wide and a week with none reads as none.
  const traded = new Map(weeks.map((week) => [week.start, week]));
  const last = Math.max(Date.parse(`${weeks.at(-1)!.start}T00:00:00Z`), closes.at(-1)?.date.getTime() ?? 0);
  const every: InsiderWeek[] = [];
  for (let time = first; time <= last; time += 7 * DAY_MS) {
    const start = new Date(time).toISOString().slice(0, 10);
    every.push(traded.get(start) ?? { start, buys: 0, planBuys: 0, sales: 0, planSales: 0 });
  }
  const bars = (id: string, label: string, color: string, value: (week: InsiderWeek) => number, sign: 1 | -1): ResolvedSeries | null => {
    if (!weeks.some((week) => value(week) > 0)) return null;
    const points = every.map((week) => scalarPoint(at(week), value(week) > 0 ? sign * value(week) : 0));
    return { ...staticSeries(points, { id, label, color, style: "columns", calendarSpaced: true }), unit: "shares", unitGroup: SHARES, axis: "left" };
  };
  const series = [
    bars("buys", "Buys", palette.buy, (week) => week.buys, 1),
    bars("plan-buys", "Plan buys", palette.planBuy, (week) => week.planBuys, 1),
    bars("sales", "Sales", palette.sell, (week) => week.sales, -1),
    bars("plan-sales", "Plan sales", palette.planSell, (week) => week.planSales, -1),
  ].filter((entry): entry is ResolvedSeries => entry != null);
  if (closes.length >= 2) {
    series.push({
      ...staticSeries(closes.map((point) => scalarPoint(point.date, point.close)), { id: "price", label: "Price", color: palette.price, calendarSpaced: true }),
      unit: "price", unitGroup: PRICE, axis: "right",
    });
  }
  return series;
}

/**
 * A legend value: `24.1k sh` bought or sold, the close `352.77` in the
 * listing's own currency (a listing abroad's close is not in Form 4 dollars).
 */
export function insiderChartValue(value: number, series?: Pick<ResolvedSeries, "unitGroup">): string {
  if (series?.unitGroup === PRICE) return value.toFixed(2);
  return `${formatCompact(Math.abs(value))} sh`;
}

const priceAxis = spanAxisFormatter((value, digits) => value.toFixed(digits), 2);
/** Shares bought and sold read as amounts either side of zero (`40k`), the close in its own currency. */
const sharesAxis = (value: number, domain: CompositeAxisDomain) => formatCompactAxis(Math.abs(value), domain);

/** The crosshair's tags read as the legend does: `2.4k` shares, not the axis's rounded `2k`. */
export const insiderAxisValue: CompositeAxisValueFormatter = Object.assign(
  (value: number, domain: CompositeAxisDomain) => (domain.unitGroup === PRICE ? priceAxis(value, domain) : sharesAxis(value, domain)),
  { tag: (value: number, domain: CompositeAxisDomain) => (domain.unitGroup === PRICE ? priceAxis.tag!(value, domain) : formatCompact(Math.abs(value))) },
);
