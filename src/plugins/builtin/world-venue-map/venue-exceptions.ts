import { hasPublishedApacCalendar, isPublishedApacClosure, publishedApacEarlyClose } from "../../../market-data/published-apac-sessions";
import { getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { canonicalExchange } from "../../../utils/exchanges";
import { zonedDateKey, zonedDayStart, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

const DAY_MS = 86_400_000;
type VenueExceptions = {
  closure: string | null;
  earlyClose: ({ date: string } & ({ at: string; local: string } | { at: null; local: null })) | null;
};
const EMPTY_EXCEPTIONS: VenueExceptions = { closure: null, earlyClose: null };
const exceptionCache = new Map<string, { since: number; until: number; exceptions: VenueExceptions }>();

export function nextVenueExceptions(mic: string, timezone: string, now: number): VenueExceptions {
  const exchange = canonicalExchange(mic);
  const us = getPublishedUsEquityCalendarYears(exchange);
  const timeZone = us ? "America/New_York" : timezone;
  if (!timeZone) return EMPTY_EXCEPTIONS;
  const key = `${exchange}:${timeZone}`;
  const cached = exceptionCache.get(key);
  if (cached && now >= cached.since && now < cached.until) return cached.exceptions;

  const today = zonedDateKey(now, timeZone);
  const year = Number(today.slice(0, 4));
  const start = Date.parse(today);
  let until = zonedDayStart(new Date(start + DAY_MS).toISOString().slice(0, 10), timeZone);
  let closure: VenueExceptions["closure"] = null;
  let earlyClose: VenueExceptions["earlyClose"] = null;
  const horizon = us || [year, year + 1].some((value) => hasPublishedApacCalendar(exchange, value)) ? 366 : -1;
  for (let offset = 0; offset <= horizon && (!closure || !earlyClose); offset++) {
    const day = new Date(start + offset * DAY_MS);
    const date = day.toISOString().slice(0, 10);
    const weekday = day.getUTCDay();
    const session = us ? getPublishedUsEquitySession(exchange, date) : null;
    if (!closure && (us ? session?.kind === "closed" && weekday !== 0 && weekday !== 6 : isPublishedApacClosure(exchange, date))) closure = date;
    if (earlyClose) continue;
    const close = session?.kind === "session" && session.close - session.open < 390 * 60_000 ? session.close : null;
    if (close != null && close > now) {
      const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(close);
      earlyClose = { date, at: new Date(close).toISOString(), local: `${time} ET` };
      until = Math.min(until, close);
    } else if (!us) {
      const minutes = publishedApacEarlyClose(exchange, date);
      if (minutes == null) continue;
      const cutoff = zonedWallClockToUtcMs(timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
        Math.floor(minutes / 60), minutes % 60, 0);
      if (cutoff <= now) continue;
      earlyClose = { date, at: null, local: null };
      until = Math.min(until, cutoff);
    }
  }
  const exceptions = { closure, earlyClose };
  exceptionCache.set(key, { since: now, until, exceptions });
  return exceptions;
}

function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(Date.parse(date));
}

export function venueExceptionLines(exceptions: ReturnType<typeof nextVenueExceptions>, width: number): string[] {
  const { closure, earlyClose } = exceptions;
  const lines = closure ? [`${shortDate(closure)} closed`] : [];
  if (earlyClose) {
    const date = `${shortDate(earlyClose.date)} early close`;
    const time = earlyClose.at ? `${earlyClose.local} / ${earlyClose.at.slice(11, 16)} UTC` : null;
    if (!time) lines.push(date);
    else if (`${date} · ${time}`.length <= width) lines.push(`${date} · ${time}`);
    else lines.push(date, time);
  }
  return lines;
}
