import type { PricePoint, Quote } from "../types/financials";
import { CONTRADICTORY_PRICES, pricePointCloseCopied, pricePointIntegrity } from "../utils/price-history-integrity";
import { calendarMonthsBefore } from "../utils/calendar-date";
import { formatShortDate } from "../utils/datetime-format";
import { barCloseDay, barSessionDay, isReturnPeriod, periodBaseDay, periodBaseIndex } from "./market/period-return";
import { getRegularSessionDisplay, headlineCloseDate } from "./market/status";

export interface PriceReturnHorizon {
  id: string;
  label: string;
  amount: number;
  unit: "month" | "year";
}

export interface PriceReturnField {
  id: string;
  label: string;
  value: number | null;
  unavailableReason?: "inconsistent-ohlc";
  /** With `inconsistent-ohlc`: the session day of the end bar (the base or the latest) whose prices contradict each other. */
  inconsistentDay?: string;
  /** The day of the close the return is measured from, `YYYY-MM-DD`: the last close on or before the period's start date. */
  baseDay?: string;
}

const DAILY_WINDOW_LEAD_DAYS = 21;

/**
 * The daily closes a Price Return strip is measured on: five years and the
 * three weeks before them, so 5Y has the close on its start date (a "5Y"
 * range starts the day after it), to the end of today in UTC, so a day keeps
 * one request.
 */
export function priceReturnDailyWindow(now = Date.now()): { start: Date; end: Date } {
  const today = new Date(Math.floor(now / 86_400_000) * 86_400_000);
  const start = new Date(Date.UTC(today.getUTCFullYear() - 5, today.getUTCMonth(), today.getUTCDate() - DAILY_WINDOW_LEAD_DAYS));
  return { start, end: new Date(today.getTime() + 86_400_000) };
}

/** The price a strip's returns run to, and the session day it is from. */
export interface PriceReturnEnd {
  day: string;
  close: number;
}

export const PRICE_RETURN_HORIZONS: PriceReturnHorizon[] = [
  { id: "1M", label: "1M", amount: 1, unit: "month" },
  { id: "3M", label: "3M", amount: 3, unit: "month" },
  { id: "6M", label: "6M", amount: 6, unit: "month" },
  { id: "1Y", label: "1Y", amount: 1, unit: "year" },
  { id: "3Y", label: "3Y", amount: 3, unit: "year" },
  { id: "5Y", label: "5Y", amount: 5, unit: "year" },
];

function coercePointDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

interface NormalizedHistory {
  /** The input's length and ends when it was read, so an array grown in place is read again. */
  length: number;
  first: PricePoint | undefined;
  last: PricePoint | undefined;
  history: readonly PricePoint[];
}

/**
 * The normalized copy of each history read before. A ticker's bars stay the
 * same array while its quote ticks, and every tick asks again with the quote
 * appended, so the bars are sorted and copied once rather than per tick.
 */
const normalizedCopies = new WeakMap<readonly PricePoint[], NormalizedHistory>();
/** Arrays built here already normalized (a copy, or one with the quote appended): read as they are. */
const normalizedArrays = new WeakSet<readonly PricePoint[]>();

function normalizePriceReturnHistory(points: readonly PricePoint[]): readonly PricePoint[] {
  if (normalizedArrays.has(points)) return points;
  const cached = normalizedCopies.get(points);
  if (cached && cached.length === points.length && cached.first === points[0] && cached.last === points.at(-1)) return cached.history;
  const byTimestamp = new Map<number, PricePoint>();
  for (const point of points) {
    const date = coercePointDate(point.date as Date | string | number);
    if (!date || (!Number.isFinite(point.close) && !pricePointIntegrity(point))) continue;
    // A pair's close its source copied from the open, which nothing rebuilt, is no day's close: a horizon's base or end
    // falls on the close before it, as across a holiday.
    if (pricePointCloseCopied(point)) continue;
    byTimestamp.set(date.getTime(), { ...point, date });
  }
  const history = [...byTimestamp.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, point]) => point);
  normalizedArrays.add(history);
  normalizedCopies.set(points, { length: points.length, first: points[0], last: points.at(-1), history });
  return history;
}

/** Each normalized bar's session day by venue (barSessionDay), kept with the bar: the zone lookup is the slow part. */
const sessionDaysByVenue = new Map<string, WeakMap<PricePoint, string>>();
/** Whether each normalized bar's OHLC contradicts itself (pricePointIntegrity). */
const inconsistentPoints = new WeakMap<PricePoint, boolean>();

function sessionDays(history: readonly PricePoint[], venue: string | undefined): string[] {
  const venueKey = venue ?? "";
  let days = sessionDaysByVenue.get(venueKey);
  if (!days) {
    days = new WeakMap();
    sessionDaysByVenue.set(venueKey, days);
  }
  return history.map((point) => {
    let day = days.get(point);
    if (day === undefined) {
      day = barSessionDay(point.date.getTime(), venue);
      days.set(point, day);
    }
    return day;
  });
}

function isInconsistent(point: PricePoint): boolean {
  let inconsistent = inconsistentPoints.get(point);
  if (inconsistent === undefined) {
    inconsistent = !!pricePointIntegrity(point);
    inconsistentPoints.set(point, inconsistent);
  }
  return inconsistent;
}

/**
 * The price a quote's returns run to: its headline, the regular session's
 * price, which stops at the close, never an after-hours or pre-market print
 * (GGAL's 1Y ran to the 29.08 after-hours print beside its 28.53 close). Dated
 * by the session that close is from, or while it trades by the quote's time
 * on the venue's clock. Null without a price.
 */
export function headlinePriceReturnEnd(quote: Quote | null | undefined, venue?: string): PriceReturnEnd | null {
  const close = getRegularSessionDisplay(quote)?.price;
  if (!quote || close == null || !Number.isFinite(close)) return null;
  // A time that is no date (a source's unknown timestamp) dates nothing.
  const timed = Number.isFinite(new Date(quote.lastUpdated).getTime());
  const day = headlineCloseDate(quote) ?? (timed ? barSessionDay(quote.lastUpdated, venue) : null);
  return day ? { day, close } : null;
}

export function appendQuoteToPriceReturnHistory(
  points: readonly PricePoint[],
  quote: Quote | null | undefined,
): readonly PricePoint[] {
  const history = normalizePriceReturnHistory(points);
  if (!quote || !Number.isFinite(quote.price) || !Number.isFinite(quote.lastUpdated)) {
    return history;
  }
  // The headline price, never an extended-hours print.
  const price = getRegularSessionDisplay(quote)?.price ?? quote.price;

  const quoteDate = new Date(quote.lastUpdated);
  if (!Number.isFinite(quoteDate.getTime())) return history;

  const latestHistoryTime = history.at(-1)?.date.getTime() ?? Number.NEGATIVE_INFINITY;
  if (quoteDate.getTime() <= latestHistoryTime) return history;

  const withQuote = [
    ...history,
    {
      date: quoteDate,
      close: price,
    },
  ];
  normalizedArrays.add(withQuote);
  return withQuote;
}

/** The calendar date a horizon ending on `day` is measured back to (periodBaseDay). */
function horizonBaseDay(day: string, horizon: PriceReturnHorizon): string {
  return isReturnPeriod(horizon.id)
    ? periodBaseDay(day, horizon.id)
    : calendarMonthsBefore(new Date(`${day}T00:00:00Z`), horizon.amount * (horizon.unit === "year" ? 12 : 1)).toISOString().slice(0, 10);
}

/** `venue` is the listing's exchange, whose clock dates its bars and quote (barSessionDay). */
export function computePriceReturnForHorizon(
  points: readonly PricePoint[],
  horizon: PriceReturnHorizon,
  venue?: string,
): number | null {
  return buildPriceReturnFields(points, venue, [horizon])[0]?.value ?? null;
}

const DAY_MS = 86_400_000;

/**
 * The bar size of a history read as returns: weekly or monthly bars close on
 * the last day of their period (barCloseDay), which a period's base is held
 * against, not the Monday they are dated by. Undefined for daily bars, and for
 * a short or irregular history, which is read by its dates.
 */
function barInterval(history: readonly PricePoint[]): "1wk" | "1mo" | undefined {
  if (history.length < 4) return undefined;
  const gaps = history.slice(1).map((point, index) => (point.date.getTime() - history[index]!.date.getTime()) / DAY_MS);
  // Most bars a week or a month apart, a holiday's week or a quote appended to them aside; a sparse history is read as dated.
  const share = (low: number, high: number) => gaps.filter((gap) => gap >= low && gap <= high).length / gaps.length;
  return share(5, 9) >= 0.8 ? "1wk" : share(26, 33) >= 0.8 ? "1mo" : undefined;
}

/**
 * `history` normalized, `days` the day each bar's close is from. A period
 * runs from the last close on or before its start date (periodBaseDay of the
 * end's day, as every period return is measured) to `end`, the headline's
 * price when given, else the newest close. No gap limit: the overview's
 * history can be sparse, and its base is whatever close it holds on or
 * before then.
 */
function priceReturnFromHistory(
  history: readonly PricePoint[],
  days: readonly string[],
  horizon: PriceReturnHorizon,
  end: PriceReturnEnd | null,
): Pick<PriceReturnField, "value" | "unavailableReason" | "inconsistentDay" | "baseDay"> {
  const inconsistentAt = (index: number) => ({ value: null, unavailableReason: "inconsistent-ohlc" as const, inconsistentDay: days[index]! });
  const last = history.at(-1);
  const final = end ?? (last ? { day: days.at(-1)!, close: last.close } : null);
  if (!final || history.length < (end ? 1 : 2)) {
    const index = history.findIndex(isInconsistent);
    return index < 0 ? { value: null } : inconsistentAt(index);
  }
  // The close on or before the same date a horizon earlier, as every period return is measured. No gap
  // limit: the overview's history can be sparse, and its base is whatever close it holds on or before then.
  // Each bar and the quote by its session day: a JPX bar stamped 00:00 JST, or a quote after a New York close, is not the UTC date's.
  const baseDay = horizonBaseDay(final.day, horizon);
  // The end's own close is never its base.
  const before = end ? days.length : days.length - 1;
  const baseIndex = periodBaseIndex(days.slice(0, before), baseDay, Number.POSITIVE_INFINITY);
  const baseline = baseIndex < 0 ? null : history[baseIndex]!;

  // A price return reads two closes, the base's and the end's. A bar between them whose prices contradict each
  // other changes neither, so only an end bar's contradiction leaves the return blank (as the sector board reads its
  // returns): 3698:HKEX's 3Y and 5Y read blank for one bad bar inside the five years before. A headline price given
  // as the end is no bar.
  if (!end && isInconsistent(last!)) return inconsistentAt(history.length - 1);
  if (baseline && isInconsistent(baseline)) return inconsistentAt(baseIndex);
  if (!baseline || !Number.isFinite(baseline.close) || baseline.close === 0) return { value: null };
  if (!Number.isFinite(final.close)) return { value: null };
  return { value: (final.close - baseline.close) / baseline.close, baseDay: days[baseIndex]! };
}

/** "1M", "1M and 3M", "1M, 3M and 1Y". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * "3Y and 5Y returns left blank: contradictory prices on 16 Jan 2025.": the returns shown blank because the bar one is
 * measured from or to has contradictory prices, with those bars' days; undefined when none is. A bad bar no shown
 * return reads is not mentioned: it changes no figure the overview shows.
 */
export function priceReturnIntegrityNotice(fields: readonly PriceReturnField[]): string | undefined {
  const blank = fields.filter((field) => field.unavailableReason === "inconsistent-ohlc");
  if (blank.length === 0) return undefined;
  const days = [...new Set(blank.flatMap((field) => field.inconsistentDay ? [field.inconsistentDay] : []))].sort();
  const on = days.length > 0 ? ` on ${listed(days.map((day) => formatShortDate(`${day}T00:00:00Z`, { utc: true })))}` : "";
  return `${listed(blank.map((field) => field.label))} ${blank.length === 1 ? "return" : "returns"} left blank: ${CONTRADICTORY_PRICES}${on}.`;
}

/**
 * Each horizon's return over `points`, from the close on or before its start
 * date to `end` (headlinePriceReturnEnd), else to the newest close. Daily
 * bars give each base the close of that day; weekly or monthly ones the last
 * close of a period ending on or before it. Each field names its base close's
 * day.
 */
export function buildPriceReturnFields(
  points: readonly PricePoint[],
  venue?: string,
  horizons: readonly PriceReturnHorizon[] = PRICE_RETURN_HORIZONS,
  end?: PriceReturnEnd | null,
): PriceReturnField[] {
  // Normalized and dated once for every horizon.
  const history = normalizePriceReturnHistory(points);
  const sessions = sessionDays(history, venue);
  const interval = barInterval(history);
  const days = interval ? sessions.map((day) => barCloseDay(day, interval, venue)) : sessions;
  // A headline older than the bars (a quote that stopped while history went on) is not the end: the newest close is.
  // Held against the newest bar's session, not the day its period closes: a weekly bar dated Monday 9 Nov closes on
  // Friday 13 Nov, after Wednesday's headline, which is still newer than the bar's Monday.
  const lastSession = sessions.at(-1);
  const final = end && (lastSession === undefined || end.day >= lastSession) ? end : null;
  return horizons.map((horizon) => ({
    id: horizon.id,
    label: horizon.label,
    ...priceReturnFromHistory(history, days, horizon, final),
  }));
}
