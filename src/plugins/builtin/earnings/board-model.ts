import type { EarningsCalendarReport, EarningsTiming } from "../../../api-client/earnings";
import { getExtendedSessionDisplay, getRegularSessionMoveDisplay } from "../../../market-data/market/status";
import { getPublishedUsEquityCalendarDay } from "../../../market-data/published-us-sessions";
import type { EarningsEvent } from "../../../types/data-provider";
import type { EarningsDateStatus, EarningsEpsBasis, Quote } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { earningsDateStatus, earningsEpsBasis, isProvisionalActual } from "../shared/earnings-report";
import { calendarStatus } from "../shared/earnings-calendar";
import { coherentEarningsValue } from "../shared/earnings-estimate-basis";
import { shortDate, surprise, weekday } from "./format";

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
  /** Whether the date is out, announced or projected; null when the source does not say. */
  dateStatus: EarningsDateStatus | null;
  marketCap: number | null;
  epsEstimate: number | null;
  /** Analysts behind `epsEstimate`. */
  epsAnalysts: number | null;
  epsActual: number | null;
  /** The actual is the company's press release's, until the calendar's replaces it. */
  provisional: boolean;
  /** Null when the reported figure's basis cannot be determined. */
  epsBasis: EarningsEpsBasis | null;
  /** Actual over estimate minus one. */
  epsSurprise: number | null;
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
export function isSession(date: string): boolean {
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
    dateStatus: earningsDateStatus(report.dateStatus),
    marketCap: report.marketCap,
    epsEstimate: report.epsEstimate,
    epsAnalysts: report.epsAnalysts,
    epsActual: report.epsActual,
    provisional: isProvisionalActual(report),
    epsBasis: earningsEpsBasis(report.epsBasis),
    epsSurprise: surprise(report.epsActual, report.epsEstimate),
    revenueEstimate: report.revenueEstimate,
    impliedMove: report.implied?.move ?? null,
    averageMove: report.averageReports >= MIN_AVERAGE_REPORTS ? report.averageMove : null,
    owned: owned.get(report.symbol) ?? null,
  };
}

/** A company the stored calendar does not carry (a listing abroad, a date past its horizon) from the per-ticker calendar. */
export function fallbackReport(event: EarningsEvent, owned: ReadonlyMap<string, Ownership>, today: string): BoardReport {
  const date = event.earningsDate.toISOString().slice(0, 10);
  const timing = event.timing === "BMO" ? "bmo" : event.timing === "AMC" ? "amc" : null;
  // Estimates in another currency would read as dollars beside the rest.
  const dollars = (field: "epsEstimate" | "revenueEstimate") => {
    const currency = event.estimateBasis?.[field]?.currency;
    return currency && currency !== "USD" ? null : coherentEarningsValue(event, field);
  };
  const epsEstimate = dollars("epsEstimate");
  return {
    key: `${event.symbol}:${date}`,
    symbol: event.symbol,
    name: event.name || event.symbol,
    date,
    timing,
    expectedTiming: false,
    // A date gone by is reported, as every earnings surface reads it (shared/earnings-calendar).
    dateStatus: calendarStatus(event, today),
    marketCap: null,
    epsEstimate,
    // The count belongs to the estimate beside it.
    epsAnalysts: epsEstimate == null ? null : coherentEarningsValue(event, "epsAnalysts"),
    epsActual: null,
    provisional: false,
    // The estimate's basis goes with it.
    epsBasis: epsEstimate == null ? null : earningsEpsBasis(event.epsBasis),
    epsSurprise: null,
    revenueEstimate: dollars("revenueEstimate"),
    impliedMove: null,
    averageMove: null,
    owned: owned.get(event.symbol) ?? null,
  };
}

/**
 * The price's move on the report so far, as a fraction, for a report out
 * today: from the close before it, so the regular session's move (or the
 * pre-market's before the open) for one out before or during the session,
 * and the after-hours or overnight print for one out after the close. Null
 * before the report, or when the quote has no trade for it yet.
 */
export function reportMove(report: Pick<BoardReport, "date" | "dateStatus" | "timing">, quote: Quote | null | undefined, today: string): number | null {
  if (!quote || report.dateStatus !== "reported" || report.date !== today || !report.timing) return null;
  // A bid and ask midpoint is no trade, so no move.
  const extended = getExtendedSessionDisplay(quote);
  const traded = extended && !extended.mark ? extended : null;
  // Out after the close, the move is the after-hours one; a last price still at the close is no after-hours trade yet.
  const percent = report.timing === "amc"
    ? traded && traded.session !== "PRE" && traded.change !== 0 ? traded.changePercent : null
    : quote.marketState === "PRE" || quote.marketState === "PREPRE"
      ? traded?.session === "PRE" ? traded.changePercent : null
      : getRegularSessionMoveDisplay(quote)?.changePercent;
  return percent != null && Number.isFinite(percent) ? percent / 100 : null;
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

/** Held names, then watched, then the rest, when the board puts mine first; one rank for all otherwise. */
export function ownershipRank(report: Pick<BoardReport, "owned">, mineFirst: boolean): number {
  return !mineFirst ? 0 : report.owned === "held" ? 0 : report.owned === "watched" ? 1 : 2;
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
  const rank = (report: BoardReport) => ownershipRank(report, mineFirst);
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
