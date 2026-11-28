import { canonicalExchange, isUsOtcVenue } from "../utils/exchanges";
import { zonedWallClockToUtcMs } from "../utils/zoned-date-time";

// Cboe's US equity exchanges (BZX/BATS) close on the same published US equity holidays and early closes.
const NYSE_VENUES = new Set(["NYSE", "AMEX", "ARCA", "NYSE NATIONAL", "NYSE CHICAGO", "NYSE TEXAS", "BATS", "CBOE"]);
const NYSE_EARLY_CLOSES = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24",
  "2027-11-26", "2028-07-03", "2028-11-24",
]);
// Published full closures, not a holiday-rule engine. Early closes are sessions.
const CLOSURES: Record<number, readonly string[]> = {
  2025: ["01-01", "01-09", "01-20", "02-17", "04-18", "05-26", "06-19", "07-04", "09-01", "11-27", "12-25"],
  2026: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
  2027: ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"],
  2028: ["01-17", "02-21", "04-14", "05-29", "06-19", "07-04", "09-04", "11-23", "12-25"],
};

export const PUBLISHED_US_EQUITY_SESSION_BASIS = {
  checkedAt: "2026-09-12",
  nyse: {
    years: [2025, 2026, 2027, 2028],
    sources: [
      "https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx",
      "https://www.nyse.com/trade/hours-calendars",
      "https://www.cboe.com/about/hours/us-equities/",
      "https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx",
    ],
  },
  // Nasdaq publishes the same full closures and 13:00 early closes as NYSE.
  nasdaq: {
    years: [2025, 2026, 2027, 2028],
    sources: [
      "https://www.nasdaq.com/docs/2025/01/06/2025holidayandtradinghours.pdf",
      "https://www.nasdaqtrader.com/Trader.aspx?id=Calendar",
      "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2024-87",
    ],
  },
  limitation: "Published schedules only; no live exceptional-closure feed or coverage for other venues/years.",
  actualCloseCoverage: "NYSE venues and Nasdaq 2025 to 2028. Regular close 16:00 and listed early close 13:00 New York time.",
} as const;

/** Calendar-day coverage is broader than verified actual-close coverage. */
export function getPublishedUsEquityCalendarYears(exchange: string): readonly number[] | null {
  const venue = canonicalExchange(exchange);
  return venue === "NASDAQ" ? PUBLISHED_US_EQUITY_SESSION_BASIS.nasdaq.years
    : NYSE_VENUES.has(venue) || isUsOtcVenue(venue) ? PUBLISHED_US_EQUITY_SESSION_BASIS.nyse.years : null;
}

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? new Date(time) : null;
}

/** A covered trading date does not by itself establish that date's close time. */
export function getPublishedUsEquityCalendarDay(exchange: string, date: string): "session" | "closed" | null {
  const day = calendarDate(date);
  if (!day || !getPublishedUsEquityCalendarYears(exchange)?.includes(day.getUTCFullYear())) return null;
  const weekday = day.getUTCDay();
  return weekday === 0 || weekday === 6 || CLOSURES[day.getUTCFullYear()]!.includes(date.slice(5)) ? "closed" : "session";
}

export type PublishedUsEquitySession = { kind: "session"; open: number; close: number } | { kind: "closed" };

const sessionCache = new Map<string, PublishedUsEquitySession | null>();

/** Published regular equity hours only; unknown venue/date/close coverage is null. */
export function getPublishedUsEquitySession(exchange: string, date: string): PublishedUsEquitySession | null {
  const venue = canonicalExchange(exchange);
  const key = `${venue}:${date}`;
  if (sessionCache.has(key)) return sessionCache.get(key)!;
  const session = publishedSession(venue, date);
  // The calendar is static, and callers look up the same few dates per bar.
  if (sessionCache.size < 4096) sessionCache.set(key, session);
  return session;
}

/**
 * Where a shortened late session after an early close is documented, by the
 * consolidated tape that carries a listing's prints. A quote's after-hours
 * price is the listing's last sale on its tape, from whichever venue printed
 * it, so one venue's own late hours do not bound it; neither does the shared
 * 13:00 regular close.
 * - CTA, Tapes A and B (listings on NYSE, NYSE American, NYSE Arca, NYSE
 *   National, NYSE Texas, formerly NYSE Chicago, and Cboe): its Extended
 *   Trading Hours FAQ (v1.3, 2026-11-20) puts End of Day at 5:01 PM on
 *   abbreviated schedule days such as the day after Thanksgiving and the day
 *   before Christmas, on the schedule it runs from 2026-11-08 (Q8, Q30). NYSE
 *   Group's calendar lists those days (NYSE_EARLY_CLOSES) and closes the NYSE
 *   American, Arca, National and Texas late sessions at 5:00 PM on each.
 *   Earlier early closes ran on CTA's previous schedule, which states no time.
 * - UTP, Tape C (Nasdaq listings): vendor alert UTP2026-34 ends the
 *   2026-11-27 post-market at 5:00 PM for the UTP Plan participants. No notice
 *   covers another early close yet.
 *
 * Sources:
 * - https://www.ctaplan.com/publicdocs/ctaplan/CTA_Extended_Trading_Hours_FAQ.pdf
 * - https://www.nyse.com/trade/hours-calendars
 * - https://www.nasdaqtrader.com/TraderNews.aspx?id=UTP2026-34
 */
const CTA_TAPE_LISTINGS = new Set(["NYSE", "AMEX", "ARCA", "NYSE NATIONAL", "NYSE CHICAGO", "NYSE TEXAS", "BATS", "CBOE"]);
const CTA_ABBREVIATED_SCHEDULE_FROM = "2026-11-08";
const UTP_SHORTENED_LATE_SESSIONS = new Set(["2026-11-27"]);

/** Whether `date`'s late session for a listing on `venue` is documented to end at 17:00 (sources above). */
function documentedEarlyLateClose(venue: string, date: string): boolean {
  if (!NYSE_EARLY_CLOSES.has(date)) return false;
  if (CTA_TAPE_LISTINGS.has(venue)) return date >= CTA_ABBREVIATED_SCHEDULE_FROM;
  return venue === "NASDAQ" && UTP_SHORTENED_LATE_SESSIONS.has(date);
}

/**
 * When the late (after-hours) session on a published session day ends for a
 * listing: 17:00 New York where its tape documents the shortened session
 * after an early close (documentedEarlyLateClose), else 20:00, the full late
 * session, so a day whose shortened hours are not established keeps expecting
 * late prints as before. Null for a day with no published session (a holiday,
 * a weekend, an OTC venue or an uncovered year).
 */
export function usEquityLateClose(exchange: string, date: string): number | null {
  const venue = canonicalExchange(exchange);
  const session = getPublishedUsEquitySession(venue, date);
  const day = calendarDate(date);
  if (session?.kind !== "session" || !day) return null;
  return zonedWallClockToUtcMs("America/New_York", day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
    documentedEarlyLateClose(venue, date) ? 17 : 20, 0, 0);
}

function publishedSession(venue: string, date: string): PublishedUsEquitySession | null {
  const day = calendarDate(date);
  if (!day) return null;
  const kind = getPublishedUsEquityCalendarDay(venue, date);
  if (!kind) return null;
  if (kind === "closed") return Object.freeze({ kind });
  if (isUsOtcVenue(venue)) return null;
  const at = (hour: number, minute = 0) => zonedWallClockToUtcMs("America/New_York",
    day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, 0);
  return Object.freeze({ kind, open: at(9, 30), close: at(NYSE_EARLY_CLOSES.has(date) ? 13 : 16) });
}
