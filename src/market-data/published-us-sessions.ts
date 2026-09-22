import { canonicalExchange } from "../utils/exchanges";
import { zonedWallClockToUtcMs } from "../utils/zoned-date-time";

// Cboe's US equity exchanges (BZX/BATS) close on the same published US equity holidays and early closes.
const NYSE_VENUES = new Set(["NYSE", "AMEX", "ARCA", "NYSE NATIONAL", "NYSE CHICAGO", "NYSE TEXAS", "BATS", "CBOE"]);
const NYSE_EARLY_CLOSES = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24",
  "2027-11-26", "2028-07-03", "2028-11-24",
]);
const NASDAQ_EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24"]);
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
  nasdaq: {
    years: [2025, 2026],
    sources: [
      "https://www.nasdaq.com/docs/2025/01/06/2025holidayandtradinghours.pdf",
      "https://www.nasdaqtrader.com/Trader.aspx?id=Calendar",
      "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2024-87",
    ],
  },
  limitation: "Published schedules only; no live exceptional-closure feed or coverage for other venues/years.",
  actualCloseCoverage: "NYSE venues 2025–2028; Nasdaq 2026 only. Regular close 16:00 and listed early close 13:00 New York time.",
} as const;

/** Calendar-day coverage is broader than verified actual-close coverage. */
export function getPublishedUsEquityCalendarYears(exchange: string): readonly number[] | null {
  const venue = canonicalExchange(exchange);
  return venue === "NASDAQ" ? PUBLISHED_US_EQUITY_SESSION_BASIS.nasdaq.years
    : NYSE_VENUES.has(venue) ? PUBLISHED_US_EQUITY_SESSION_BASIS.nyse.years : null;
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

/** Published regular equity hours only; unknown venue/date/close coverage is null. */
export function getPublishedUsEquitySession(exchange: string, date: string): PublishedUsEquitySession | null {
  const venue = canonicalExchange(exchange);
  const day = calendarDate(date);
  if (!day || (venue === "NASDAQ" && day.getUTCFullYear() !== 2026)) return null;
  const kind = getPublishedUsEquityCalendarDay(venue, date);
  if (!kind) return null;
  if (kind === "closed") return { kind };
  const earlyCloses = venue === "NASDAQ" ? NASDAQ_EARLY_CLOSES : NYSE_EARLY_CLOSES;
  const at = (hour: number, minute = 0) => zonedWallClockToUtcMs("America/New_York",
    day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, 0);
  return { kind, open: at(9, 30), close: at(earlyCloses.has(date) ? 13 : 16) };
}
