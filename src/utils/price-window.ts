import { dateOptionError, isoDateToday, readCalendarDate } from "./calendar-date";
import { fetchHistoryResult } from "../sources/history-result";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { PriceHistoryResult } from "../types/price-history";
import { getPricePointTimestamp } from "./price-history";

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
const FORMATS = "a year (2007) or a date (2008-09-15)";

function readBound(value: string, flag: "--from" | "--to", now: Date): string {
  const text = value.trim();
  if (YEAR.test(text)) return flag === "--from" ? `${text}-01-01` : `${text}-12-31`;
  const date = text ? readCalendarDate(text) : null;
  if (date) return date;
  throw new Error(`Invalid ${flag} "${value}". ${dateOptionError(text, flag, { now, subject: `the window's ${flag === "--from" ? "start" : "end"}`, formats: FORMATS, example: flag === "--from" ? "2007" : "2009" })}`);
}

/**
 * The window `--from` and `--to` name, or null when neither was given. Throws
 * a message naming the option for a value that is no year or date, a `--to`
 * alone, a start after the end, or a start still ahead. An end past today
 * stops at today.
 */
export function readPriceWindow(from: string | undefined, to: string | undefined, now = new Date()): PriceWindow | null {
  if (from == null && to == null) return null;
  if (from == null) throw new Error(`--to needs a --from: --from ${YEAR.test(to!.trim()) ? Number(to!.trim()) - 2 : 2007} --to ${to!.trim()}.`);
  const today = isoDateToday(now);
  const start = readBound(from, "--from", now);
  const typedEnd = to == null ? today : readBound(to, "--to", now);
  if (start > today) throw new Error(`--from ${from.trim()} has not started yet. Use a start on or before ${today}.`);
  if (start > typedEnd) {
    throw new Error(`--from ${from.trim()} is after --to ${to!.trim()}. The window runs from the earlier to the later, such as --from ${to!.trim()} --to ${from.trim()}.`);
  }
  return { from: start, to: typedEnd > today ? today : typedEnd };
}

/** The window in words: `2007 to 2009`, `2008-09-15 to 2009-03-31`, `2007 to today`. */
export function priceWindowText(window: PriceWindow, now = new Date()): string {
  const year = (date: string, edge: "start" | "end") => date.slice(5) === (edge === "start" ? "01-01" : "12-31") ? date.slice(0, 4) : date;
  const end = window.to === isoDateToday(now) ? "today" : year(window.to, "end");
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
 * The bars of a window, in the size `priceWindowInterval` picks: the source's
 * bars for those dates, else, from a source that serves no dated request, its
 * whole history in that size. Either way only bars dated inside the window
 * are kept.
 */
export async function loadPriceWindowHistory(
  provider: DataProvider, symbol: string, exchange: string, window: PriceWindow, context?: MarketDataRequestContext,
): Promise<PriceHistoryResult> {
  const interval = priceWindowInterval(window);
  const start = new Date(`${window.from}T00:00:00Z`);
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
