import { canonicalExchange } from "../../utils/exchanges";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../../utils/zoned-date-time";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FRIDAY = 5;

/**
 * CME Group's Globex week runs from Sunday 17:00 Central to Friday 16:00
 * Central, 17:00 in New York, which ICE Futures U.S. keeps too
 * (cmegroup.com/trading-hours, ice.com). Nothing trades between, whatever
 * state a quote stamped before the Friday close still carries. The venues
 * have no other calendar here: their daily breaks and holiday sessions vary
 * by contract, so the quote's own state says those.
 */
const WEEK_ZONE = "America/Chicago";
const WEEK_CLOSE_MINUTES = 16 * 60;
const WEEK_OPEN_MINUTES = 17 * 60;

/**
 * The futures venues the weekly gap covers, and whether the week's first open
 * is theirs to name: every Globex contract opens by Sunday 17:00 Central, but
 * an ICE U.S. one opens when its own hours say, from Sunday evening (cotton)
 * to Monday morning (coffee), so the venue has no one reopen to give.
 */
const WEEK_VENUES: Readonly<Record<string, { reopens: boolean }>> = {
  CME: { reopens: true },
  CBT: { reopens: true },
  NYM: { reopens: true },
  CMX: { reopens: true },
  NYB: { reopens: false },
};

export interface FuturesWeekendClosure {
  /** The Friday close that began it. */
  closedAt: number;
  /** The Sunday open that ends it, when the venue's contracts all open then or later. */
  reopensAt?: number;
  /** That open's local date, `YYYY-MM-DD` (always a Sunday). */
  reopensOn?: string;
}

/**
 * The weekend gap of a futures venue's week that `time` falls in, from the
 * Friday close to the Sunday open; null on any other instant, and for a venue
 * that is not a futures exchange here. Only ever the closed side: a moment
 * outside it is not known to be open.
 */
export function futuresWeekendClosure(exchange: string | undefined, time: number): FuturesWeekendClosure | null {
  const venue = WEEK_VENUES[canonicalExchange(exchange)];
  if (!venue || !Number.isFinite(time)) return null;
  const { year, month, day } = zonedDateTimeParts(time, WEEK_ZONE);
  const today = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  const weekday = new Date(today * MS_PER_DAY).getUTCDay();
  // The latest Friday on or before the local date: a Monday to Thursday reads last week's, whose gap has ended.
  const friday = today - ((weekday - FRIDAY + 7) % 7);
  const at = (days: number, minutes: number) => {
    const date = new Date(days * MS_PER_DAY);
    return zonedWallClockToUtcMs(WEEK_ZONE, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      Math.floor(minutes / 60), minutes % 60, 0);
  };
  const closedAt = at(friday, WEEK_CLOSE_MINUTES);
  const reopensAt = at(friday + 2, WEEK_OPEN_MINUTES);
  if (time < closedAt || time >= reopensAt) return null;
  return {
    closedAt,
    ...(venue.reopens ? { reopensAt, reopensOn: new Date((friday + 2) * MS_PER_DAY).toISOString().slice(0, 10) } : {}),
  };
}
