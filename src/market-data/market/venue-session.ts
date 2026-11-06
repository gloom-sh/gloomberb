import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { zonedDateKey } from "../../utils/zoned-date-time";
import {
  isAlwaysOpenExchange,
  isRegularSessionTime,
  isTradingWeekday,
  isVenueTradingDay,
  middayBreakOn,
  nextRegularSessionOpen,
  regularSessionCloseOn,
} from "./freshness";

/**
 * Where a venue's trading day stands: in its regular session, paused for
 * lunch, in a US listing's pre-market or after-hours, closed for the night
 * or a weekend, or closed on a weekday for a published holiday.
 */
export type VenueSessionPhase = "open" | "lunch" | "pre-market" | "after-hours" | "closed" | "holiday";

export interface VenueSessionNow {
  phase: VenueSessionPhase;
  /** The venue's own zone, which its hours are read in. */
  timeZone: string;
  /** While open: when the regular session closes, a published early close included. */
  closesAt?: number;
  /** Otherwise: when the regular session opens next, or the afternoon session after a lunch break. */
  opensAt?: number;
}

/** A US listing's after-hours session runs four hours past the regular close (to 20:00, 17:00 after a 13:00 close). */
const US_AFTER_HOURS_MS = 4 * 60 * 60_000;
/** The US pre-market opens at 04:00 New York, five and a half hours before the regular open. */
const US_PRE_MARKET_MS = 5.5 * 60 * 60_000;

/**
 * A venue's session at `now`, from its own hours and published calendar
 * (`freshness`): its regular open and close, its midday break, its weekend
 * and holidays, and for a US listing the pre-market and after-hours around
 * the regular session. Null for a venue whose hours the app does not know
 * and for one that trades around the clock.
 */
export function venueSessionNow(exchange: string | undefined, now: number): VenueSessionNow | null {
  const venue = canonicalExchange(exchange);
  if (!venue || isAlwaysOpenExchange(venue) || !Number.isFinite(now)) return null;
  const next = nextRegularSessionOpen(venue, now);
  if (!next) return null;
  const { timeZone } = next;
  const today = zonedDateKey(now, timeZone);
  if (isRegularSessionTime(venue, now)) {
    const pause = middayBreakOn(venue, now);
    if (pause && now >= pause.start && now < pause.end) return { phase: "lunch", timeZone, opensAt: pause.end };
    const closesAt = regularSessionCloseOn(venue, today);
    return { phase: "open", timeZone, ...(closesAt != null && closesAt > now ? { closesAt } : {}) };
  }
  const opensAt = next.open;
  if (!isVenueTradingDay(venue, today)) {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    return { phase: isTradingWeekday(venue, weekday) ? "holiday" : "closed", timeZone, opensAt };
  }
  if (isUsListingExchange(venue)) {
    if (next.date === today && now >= opensAt - US_PRE_MARKET_MS) return { phase: "pre-market", timeZone, opensAt };
    const closed = regularSessionCloseOn(venue, today);
    if (closed != null && now >= closed && now < closed + US_AFTER_HOURS_MS) return { phase: "after-hours", timeZone, opensAt };
  }
  return { phase: "closed", timeZone, opensAt };
}
