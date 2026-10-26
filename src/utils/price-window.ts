import { dateOptionError, isoDateToday, readCalendarDate } from "./calendar-date";
import { fetchHistoryResult } from "../sources/history-result";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { PriceHistoryResult } from "../types/price-history";
import { getPricePointTimestamp } from "./price-history";
import { zonedDateKey } from "./zoned-date-time";

/**
 * A price-history window typed as `--from` and `--to`: a year (2007) or a date
 * (2008-09-15, or any form `readCalendarDate` reads). A year runs from 1 Jan
 * as a start and to 31 Dec as an end. Without `--to` the window runs to
 * today; `--to` needs a `--from`. Dates are YYYY-MM-DD, both inclusive.
 */
export interface PriceWindow {
  from: string;
  to: string;
}

const YEAR = /^\d{4}$/;
const DAY_MS = 86_400_000;

/**
 * Today as the window reads it: the reader's date (in `timeZone`, the host's
 * when not given), or UTC's when that is later, so a date that has begun for
 * the reader (east of UTC, or in UTC already) is never refused as still ahead.
 */
function priceWindowToday(now: Date, timeZone?: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const local = timeZone ? zonedDateKey(now.getTime(), timeZone) : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const utc = isoDateToday(now);
  return local > utc ? local : utc;
}

/** Whether the window closed before today in UTC: its bars are history, with no session still trading in them. */
export function isPastPriceWindow(window: PriceWindow, now = new Date()): boolean {
  return window.to < isoDateToday(now);
}

const FORMATS = "a year (2007) or a date (2008-09-15)";

function readBound(value: string, edge: "start" | "end", flag: string, now: Date): string {
  const text = value.trim();
  if (YEAR.test(text)) return edge === "start" ? `${text}-01-01` : `${text}-12-31`;
  const date = text ? readCalendarDate(text) : null;
  if (date) return date;
  throw new Error(`Invalid ${flag} "${value}". ${dateOptionError(text, flag, { now, subject: `the window's ${edge}`, formats: FORMATS, example: edge === "start" ? "2007" : "2009" })}`);
}

/**
 * The window `--from` and `--to` name, or null when neither was given. Throws
 * a message naming the option for a value that is no year or date, a `--to`
 * alone, a start after the end, or a start still ahead. An end past today
 * stops at today.
 */
export function readPriceWindow(
  from: string | undefined,
  to: string | undefined,
  now = new Date(),
  timeZone?: string,
  /** The options as typed, for the messages: `--start` and `--end` where a command takes those too. */
  flags: { from: string; to: string } = { from: "--from", to: "--to" },
): PriceWindow | null {
  if (from == null && to == null) return null;
  const { from: fromFlag, to: toFlag } = flags;
  if (from == null) throw new Error(`${toFlag} needs a ${fromFlag}: ${fromFlag} ${YEAR.test(to!.trim()) ? Number(to!.trim()) - 2 : 2007} ${toFlag} ${to!.trim()}.`);
  const today = priceWindowToday(now, timeZone);
  const start = readBound(from, "start", fromFlag, now);
  const typedEnd = to == null ? today : readBound(to, "end", toFlag, now);
  if (start > today) throw new Error(`${fromFlag} ${from.trim()} has not started yet. Use a start on or before ${today}.`);
  if (start > typedEnd) {
    throw new Error(`${fromFlag} ${from.trim()} is after ${toFlag} ${to!.trim()}. The window runs from the earlier to the later, such as ${fromFlag} ${to!.trim()} ${toFlag} ${from.trim()}.`);
  }
  return { from: start, to: typedEnd > today ? today : typedEnd };
}

/** The window in words: `2007 to 2009`, `2008-09-15 to 2009-03-31`, `2007 to today`. */
export function priceWindowText(window: PriceWindow, now = new Date(), timeZone?: string): string {
  const year = (date: string, edge: "start" | "end") => date.slice(5) === (edge === "start" ? "01-01" : "12-31") ? date.slice(0, 4) : date;
  const end = window.to === priceWindowToday(now, timeZone) ? "today" : year(window.to, "end");
  return `${year(window.from, "start")} to ${end}`;
}

/** Calendar days the window spans, both ends counted. */
function priceWindowDays(window: PriceWindow): number {
  return Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Daily bars up to five years, weekly up to twenty, monthly beyond: the sizes `history`'s 1Y, 5Y and ALL come in. */
export function priceWindowInterval(window: PriceWindow): "1d" | "1wk" | "1mo" {
  const days = priceWindowDays(window);
  return days <= 5 * 366 ? "1d" : days <= 20 * 366 ? "1wk" : "1mo";
}

/**
 * Where the bar of this size that holds `date` starts, at midnight UTC: the
 * day itself, its week's Monday (weekly bars are dated by the Monday) or its
 * month's 1st. A window keeps the week or month its first date falls in.
 */
export function priceWindowBarStart(date: string, interval: string): number {
  const day = Date.parse(`${date}T00:00:00Z`);
  if (interval === "1wk") return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
  if (interval === "1mo") return Date.parse(`${date.slice(0, 7)}-01T00:00:00Z`);
  return day;
}

/**
 * The bars of a window, in the size `priceWindowInterval` picks: the source's
 * bars for those dates, else, from a source that serves no dated request, its
 * whole history in that size. Either way only bars inside the window are
 * kept, with the week or month its first date falls in (`--from 2008-09-15`
 * in monthly bars starts with September 2008's).
 */
export async function loadPriceWindowHistory(
  provider: DataProvider, symbol: string, exchange: string, window: PriceWindow, context?: MarketDataRequestContext,
): Promise<PriceHistoryResult> {
  const interval = priceWindowInterval(window);
  const start = new Date(priceWindowBarStart(window.from, interval));
  const end = new Date(`${window.to}T23:59:59Z`);
  const result = await fetchHistoryResult(provider, symbol, exchange, { kind: "detail", start, end, interval }, context)
    ?? await fetchHistoryResult(provider, symbol, exchange, { kind: "resolution", range: "ALL", resolution: interval }, context)
    ?? await fetchHistoryResult(provider, symbol, exchange, { kind: "range", range: "ALL" }, context);
  const points = (result?.points ?? []).filter((point) => {
    const time = getPricePointTimestamp(point);
    return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime();
  });
  return { ...(result ?? { resolution: null }), points };
}

/** Shared help text for `--from` and `--to`. */
export const PRICE_WINDOW_FROM_HELP = `First year or date of the window, as ${FORMATS}; replaces --range`;
export const PRICE_WINDOW_TO_HELP = "Last year or date of the window, with --from (default today)";
