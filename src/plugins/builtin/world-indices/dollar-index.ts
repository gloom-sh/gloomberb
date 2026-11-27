import type { Quote } from "../../../types/financials";
import { quoteFeedDelayMinutes } from "../../../market-data/market/freshness";
import { hasValidQuoteObservationTime } from "../../../market-data/quotes/freshness";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

const ZONE = "America/New_York";
const DAY = 86_400_000;
const MINUTE = 60_000;
export const DOLLAR_INDEX_SYMBOL = "DX-Y.NYB";

function observedFixedHoliday(year: number, month: number, day: number, observeSaturday: boolean): number {
  const date = Date.UTC(year, month, day);
  const weekday = new Date(date).getUTCDay();
  return date + (weekday === 6 && observeSaturday ? -DAY : weekday === 0 ? DAY : 0);
}

/** ICE FX Indexes Methodology §4.1: cash index publication, not ICE futures or US equity hours. */
function dollarIndexSessionEnd(now: number): number {
  const { year, month, day } = zonedDateTimeParts(now, ZONE);
  const localDay = Date.UTC(year, month - 1, day);
  const at = (dayStamp: number, hour: number, minute: number) => {
    const date = new Date(dayStamp);
    return zonedWallClockToUtcMs(ZONE, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, 0);
  };
  for (let stamp = localDay + DAY; ; stamp -= DAY) {
    const date = new Date(stamp);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const dateYear = date.getUTCFullYear();
    if (stamp === observedFixedHoliday(dateYear, 11, 25, true)
      || stamp === observedFixedHoliday(dateYear, 0, 1, false)) continue;
    const start = weekday === 1 ? at(stamp - DAY, 18, 0) : at(stamp - DAY, 19, 45);
    if (start <= now) return weekday === 5 ? at(stamp, 17, 0) : at(stamp, 19, 15);
  }
}

export function dollarIndexQuoteStatus(symbol: string, quote: Quote | null | undefined, now = Date.now()) {
  if (symbol !== DOLLAR_INDEX_SYMBOL || !quote || !Number.isFinite(now)) return null;
  const sessionEnd = dollarIndexSessionEnd(now);
  const expectedAt = now - ((quoteFeedDelayMinutes(quote) ?? 0) + 5) * MINUTE;
  const expectedEnd = dollarIndexSessionEnd(expectedAt);
  // A closed market can stand at its final print, not at an arbitrary intraday quote.
  const oldest = Math.min(expectedAt, expectedEnd - MINUTE);
  return {
    marketState: now < sessionEnd ? "REGULAR" as const : "CLOSED" as const,
    stale: quote.stale === true || !hasValidQuoteObservationTime(quote, now) || quote.lastUpdated < oldest,
  };
}
