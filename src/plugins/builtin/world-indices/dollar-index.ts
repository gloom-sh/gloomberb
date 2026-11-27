import type { Quote } from "../../../types/financials";
import { quoteFeedDelayMinutes } from "../../../market-data/market/freshness";
import { hasValidQuoteObservationTime } from "../../../market-data/quotes/freshness";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

const ZONE = "America/New_York";
const DAY = 86_400_000;
const MINUTE = 60_000;
export const DOLLAR_INDEX_SYMBOL = "DX-Y.NYB";

function fixedHoliday(stamp: number): boolean {
  const date = new Date(stamp);
  return (date.getUTCMonth() === 11 && date.getUTCDate() === 25)
    || (date.getUTCMonth() === 0 && date.getUTCDate() === 1);
}

function possibleObservedHoliday(stamp: number): boolean {
  const weekday = new Date(stamp).getUTCDay();
  return (weekday === 5 && fixedHoliday(stamp + DAY)) || (weekday === 1 && fixedHoliday(stamp - DAY));
}

/** ICE FX Indexes Methodology §4.1: cash index publication, not ICE futures or US equity hours. */
function dollarIndexSession(now: number) {
  const { year, month, day } = zonedDateTimeParts(now, ZONE);
  const localDay = Date.UTC(year, month - 1, day);
  const at = (dayStamp: number, hour: number, minute: number) => {
    const date = new Date(dayStamp);
    return zonedWallClockToUtcMs(ZONE, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, 0);
  };
  for (let stamp = localDay + DAY; ; stamp -= DAY) {
    const weekday = new Date(stamp).getUTCDay();
    if (weekday === 0 || weekday === 6 || fixedHoliday(stamp)) continue;
    const priorDay = stamp - DAY;
    const holidayReopening = fixedHoliday(priorDay) || possibleObservedHoliday(priorDay);
    const start = weekday === 1 ? at(priorDay, 18, 0) : at(priorDay, 19, 45);
    if (start <= now || (priorDay === localDay && holidayReopening)) {
      const end = weekday === 5 ? at(stamp, 17, 0) : at(stamp, 19, 15);
      const confirmed = !possibleObservedHoliday(stamp) && !holidayReopening;
      return { start, end, confirmed };
    }
  }
}

export function dollarIndexQuoteStatus(symbol: string, quote: Quote | null | undefined, now = Date.now()) {
  if (symbol !== DOLLAR_INDEX_SYMBOL || !quote || !Number.isFinite(now)) return null;
  const session = dollarIndexSession(now);
  const expectedAt = now - ((quoteFeedDelayMinutes(quote) ?? 0) + 5) * MINUTE;
  const expected = dollarIndexSession(expectedAt);
  const observed = quote.lastUpdated;
  // A closed market can stand at its final print, not at an arbitrary intraday quote.
  const withinExpected = expected.confirmed && observed >= Math.max(expected.start, Math.min(expectedAt, expected.end - MINUTE)) && observed <= expected.end;
  const newSessionPrint = session.start > expected.start && observed >= session.start && observed <= now && observed <= session.end;
  return {
    marketState: session.confirmed ? now < session.end ? "REGULAR" as const : "CLOSED" as const : null,
    stale: !session.confirmed || quote.stale === true || !hasValidQuoteObservationTime(quote, now) || !(withinExpected || newSessionPrint),
  };
}
