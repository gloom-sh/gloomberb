import { hasPublishedApacCalendar, isPublishedApacClosure, publishedApacEarlyClose } from "../../../market-data/published-apac-sessions";
import { getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { canonicalExchange } from "../../../utils/exchanges";
import { zonedDateKey, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

const DAY_MS = 86_400_000;

export function nextVenueExceptions(mic: string, timezone: string, now: number) {
  const exchange = canonicalExchange(mic);
  const us = getPublishedUsEquityCalendarYears(exchange);
  let closure: string | null = null;
  let earlyClose: { date: string; at: string; local: string } | null = null;
  const timeZone = us ? "America/New_York" : timezone;
  const year = Number(zonedDateKey(now, "UTC").slice(0, 4));
  if (!us && ![year - 1, year, year + 1].some((value) => hasPublishedApacCalendar(exchange, value))) return { closure, earlyClose };
  if (!timeZone) return { closure, earlyClose };
  const start = Date.parse(zonedDateKey(now, timeZone));
  for (let offset = 0; offset <= 366 && (!closure || !earlyClose); offset++) {
    const day = new Date(start + offset * DAY_MS);
    const date = day.toISOString().slice(0, 10);
    const weekday = day.getUTCDay();
    const localAt = (hour: number, minute = 0) => zonedWallClockToUtcMs(timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, 0);
    const session = us ? getPublishedUsEquitySession(exchange, date) : null;
    if (!closure && (us ? session?.kind === "closed" && weekday !== 0 && weekday !== 6 : isPublishedApacClosure(exchange, date))) closure = date;
    const apacClose = us ? undefined : publishedApacEarlyClose(exchange, date);
    const close = session?.kind === "session" && session.close - session.open < 390 * 60_000 ? session.close
      : apacClose == null ? null : localAt(Math.floor(apacClose / 60), apacClose % 60);
    if (!earlyClose && close != null && close > now) {
      const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(close);
      earlyClose = { date, at: new Date(close).toISOString(), local: `${time} ${us ? "ET" : "local"}` };
    }
  }
  return { closure, earlyClose };
}

function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(Date.parse(date));
}

export function venueExceptionLines(exceptions: ReturnType<typeof nextVenueExceptions>, width: number): string[] {
  const { closure, earlyClose } = exceptions;
  const lines = closure ? [`${shortDate(closure)} closed`] : [];
  if (earlyClose) {
    const date = `${shortDate(earlyClose.date)} early close`;
    const time = `${earlyClose.local} / ${earlyClose.at.slice(11, 16)} UTC`;
    if (`${date} · ${time}`.length <= width) lines.push(`${date} · ${time}`);
    else lines.push(date, time);
  }
  return lines;
}
