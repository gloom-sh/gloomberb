import type { EarningsCalendarReport, EarningsTiming } from "../../../api-client/earnings";
import { getPublishedUsEquityCalendarDay } from "../../../market-data/published-us-sessions";
import type { EarningsEvent } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { coherentEarningsValue } from "./estimate-basis";
import { shortDate, weekday } from "./format";

/** A held name is in a portfolio; a watched one only in watchlists. */
export type Ownership = "held" | "watched";

export interface BoardReport {
  key: string;
  symbol: string;
  name: string;
  date: string;
  timing: EarningsTiming | null;
  /** Timing taken from the company's last reports, not announced yet. */
  expectedTiming: boolean;
  marketCap: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  impliedMove: number | null;
  averageMove: number | null;
  owned: Ownership | null;
}

export type BoardRow =
  | { kind: "section"; key: string; label: string }
  | { kind: "report"; key: string; report: BoardReport; showDay: boolean };

export type BoardSort = { column: "symbol" | "cap" | "implied" | "average"; direction: "asc" | "desc" };

/** An average of fewer reports says more about one quarter than about the company. */
export const MIN_AVERAGE_REPORTS = 4;

const DAY_MS = 86_400_000;
const newYorkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export function newYorkToday(now = new Date()): string {
  return newYorkDate.format(now);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** NYSE sessions from the published calendar; weekdays for years it does not cover. */
function isSession(date: string): boolean {
  const known = getPublishedUsEquityCalendarDay("NYSE", date);
  if (known) return known === "session";
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function nextSession(date: string): string {
  let cursor = addDays(date, 1);
  while (!isSession(cursor)) cursor = addDays(cursor, 1);
  return cursor;
}

/** The Friday closing the week that `date` falls in. */
function weekEnd(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, (5 - day + 7) % 7);
}

export interface MarketDay {
  label: string;
  from: string;
  to: string;
}

/**
 * The market's earnings days: today when it trades, the next session, then
 * the rest of that session's week. When the next session ends its week (a
 * Thursday), the following week stands in for the rest.
 */
export function marketDays(today: string): MarketDay[] {
  const days: MarketDay[] = [];
  if (isSession(today)) days.push({ label: "Today", from: today, to: today });
  const next = nextSession(today);
  days.push({ label: next === addDays(today, 1) ? "Tomorrow" : `${weekday(next)} ${shortDate(next)}`, from: next, to: next });
  const restStart = addDays(next, 1);
  const restEnd = weekEnd(next);
  if (restStart <= restEnd) days.push({ label: "Rest of week", from: restStart, to: restEnd });
  else days.push({ label: "Next week", from: restStart, to: weekEnd(restStart) });
  return days;
}

/** Upcoming reports for named companies: the old calendar's buckets. */
export function relativeDays(today: string): MarketDay[] {
  const tomorrow = addDays(today, 1);
  // Weeks run Sunday to Saturday.
  const nextSunday = addDays(today, 7 - new Date(`${today}T00:00:00Z`).getUTCDay());
  return [
    { label: "Today", from: today, to: today },
    { label: "Tomorrow", from: tomorrow, to: tomorrow },
    { label: "This week", from: addDays(tomorrow, 1), to: addDays(nextSunday, -1) },
    { label: "Next week", from: nextSunday, to: addDays(nextSunday, 6) },
    { label: "Later", from: addDays(nextSunday, 7), to: "9999-12-31" },
  ];
}

export function ownershipBySymbol(tickers: Iterable<TickerRecord>): ReadonlyMap<string, Ownership> {
  const owned = new Map<string, Ownership>();
  for (const { metadata } of tickers) {
    const symbol = metadata.ticker.trim().toUpperCase();
    if (metadata.portfolios.length > 0) owned.set(symbol, "held");
    else if (metadata.watchlists.length > 0 && !owned.has(symbol)) owned.set(symbol, "watched");
  }
  return owned;
}

export function boardReport(report: EarningsCalendarReport, owned: ReadonlyMap<string, Ownership>): BoardReport {
  return {
    key: `${report.symbol}:${report.date}`,
    symbol: report.symbol,
    name: report.name ?? report.symbol,
    date: report.date,
    timing: report.timing,
    expectedTiming: report.timingSource === "history",
    marketCap: report.marketCap,
    epsEstimate: report.epsEstimate,
    epsActual: report.epsActual,
    revenueEstimate: report.revenueEstimate,
    impliedMove: report.implied?.move ?? null,
    averageMove: report.averageReports >= MIN_AVERAGE_REPORTS ? report.averageMove : null,
    owned: owned.get(report.symbol) ?? null,
  };
}

/** A company the stored calendar does not carry (a listing abroad, a date past its horizon) from the per-ticker calendar. */
export function fallbackReport(event: EarningsEvent, owned: ReadonlyMap<string, Ownership>): BoardReport {
  const date = event.earningsDate.toISOString().slice(0, 10);
  const timing = event.timing === "BMO" ? "bmo" : event.timing === "AMC" ? "amc" : null;
  // Estimates in another currency would read as dollars beside the rest.
  const dollars = (field: "epsEstimate" | "revenueEstimate") => {
    const currency = event.estimateBasis?.[field]?.currency;
    return currency && currency !== "USD" ? null : coherentEarningsValue(event, field);
  };
  return {
    key: `${event.symbol}:${date}`,
    symbol: event.symbol,
    name: event.name || event.symbol,
    date,
    timing,
    expectedTiming: false,
    marketCap: null,
    epsEstimate: dollars("epsEstimate"),
    epsActual: null,
    revenueEstimate: dollars("revenueEstimate"),
    impliedMove: null,
    averageMove: null,
    owned: owned.get(event.symbol) ?? null,
  };
}

function compare(left: BoardReport, right: BoardReport, sort: BoardSort): number {
  const value = (report: BoardReport) =>
    sort.column === "cap" ? report.marketCap : sort.column === "implied" ? report.impliedMove
      : sort.column === "average" ? report.averageMove : null;
  if (sort.column === "symbol") {
    const order = left.symbol.localeCompare(right.symbol);
    return sort.direction === "asc" ? order : -order;
  }
  const a = value(left);
  const b = value(right);
  // Missing values sink whichever way the column sorts.
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1;
  return sort.direction === "asc" ? a - b : b - a;
}

/**
 * Sections in date order, each ranked by the sort (largest company first by
 * default). With `mineFirst`, held names lead, then watched, then the rest.
 */
export function boardRows(
  reports: readonly BoardReport[],
  days: readonly MarketDay[],
  sort: BoardSort,
  mineFirst: boolean,
): BoardRow[] {
  const rank = (report: BoardReport) => (!mineFirst ? 0 : report.owned === "held" ? 0 : report.owned === "watched" ? 1 : 2);
  const rows: BoardRow[] = [];
  for (const day of days) {
    const inDay = reports
      .filter((report) => report.date >= day.from && report.date <= day.to)
      .sort((left, right) => rank(left) - rank(right) || compare(left, right, sort)
        || left.date.localeCompare(right.date) || left.symbol.localeCompare(right.symbol));
    if (inDay.length === 0) continue;
    rows.push({ kind: "section", key: `section:${day.label}`, label: `${day.label} (${inDay.length})` });
    const showDay = day.from !== day.to;
    for (const report of inDay) rows.push({ kind: "report", key: report.key, report, showDay });
  }
  return rows;
}
