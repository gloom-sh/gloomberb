import type { CloudEarningsCallPayload } from "../../../api-client";
import type { TableSection } from "../../../components";
import { formatCountdown } from "../../../utils/datetime-format";
import { addDays, marketDays, newYorkToday, type MarketDay } from "../earnings/board-model";
import { shortDate, weekday } from "../earnings/format";

const DAY_MS = 86_400_000;

/**
 * Whether a call's `callAt` is its start. A call known by its day alone is
 * stored at 00:00 UTC of that New York day; a server that does not say which
 * is read the same way.
 */
export function callTimeKnown(call: Pick<CloudEarningsCallPayload, "callAt" | "callTimeKnown">): boolean {
  const at = call.callAt ? Date.parse(call.callAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  if (typeof call.callTimeKnown === "boolean") return call.callTimeKnown;
  return at % DAY_MS !== 0;
}

/** The New York day a call is on (YYYY-MM-DD): its start's, or the day it is known by. */
export function callDay(call: Pick<CloudEarningsCallPayload, "callAt" | "callTimeKnown">): string | null {
  const at = call.callAt ? Date.parse(call.callAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return callTimeKnown(call) ? newYorkToday(new Date(at)) : new Date(at).toISOString().slice(0, 10);
}

/**
 * A call still to come: no transcript yet, and its start ahead, or, known by
 * its day alone, that day today or later in New York. A transcribed call has
 * happened, whatever its date says.
 */
export function isUpcomingCall(call: CloudEarningsCallPayload, now = Date.now()): boolean {
  if (call.hasTranscript) return false;
  if (callTimeKnown(call)) return Date.parse(call.callAt!) > now;
  const day = callDay(call);
  return day !== null && day >= newYorkToday(new Date(now));
}

/** Earliest first: by New York day, then the calls with a start, in order, then those known by the day. */
export function compareCallStarts(left: CloudEarningsCallPayload, right: CloudEarningsCallPayload): number {
  const leftDay = callDay(left) ?? "9999-12-31";
  const rightDay = callDay(right) ?? "9999-12-31";
  if (leftDay !== rightDay) return leftDay < rightDay ? -1 : 1;
  const leftKnown = callTimeKnown(left);
  const rightKnown = callTimeKnown(right);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  return (Date.parse(left.callAt ?? "") || 0) - (Date.parse(right.callAt ?? "") || 0) || left.ticker.localeCompare(right.ticker);
}

/** A company's next call: the soonest of its calls still to come. */
export function nextCall(calls: readonly CloudEarningsCallPayload[], now = Date.now()): CloudEarningsCallPayload | null {
  return calls.filter((call) => isUpcomingCall(call, now)).sort(compareCallStarts)[0] ?? null;
}

const localDay = (at: number) => {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
};

/**
 * How far away a call is. With its start: "in 25m" and "in 3h" within a day
 * (the countdown econ events use), then its weekday on this machine's clock
 * within the week ("Thu"), then its date ("Oct 30"); "started" once it has.
 * Known by its day alone: "today", "tomorrow", then the same.
 */
export function callCountdown(call: CloudEarningsCallPayload, now = Date.now()): string {
  const day = callDay(call);
  if (!day) return "";
  if (!callTimeKnown(call)) {
    const today = newYorkToday(new Date(now));
    if (day < today) return shortDate(day);
    if (day === today) return "today";
    if (day === addDays(today, 1)) return "tomorrow";
    return day <= addDays(today, 6) ? weekday(day) : shortDate(day);
  }
  const at = Date.parse(call.callAt!);
  const ahead = at - now;
  if (ahead <= 0) return "started";
  if (ahead < DAY_MS) return formatCountdown(ahead);
  const days = Math.round((localDay(at) - localDay(now)) / DAY_MS);
  const date = new Date(at);
  const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return days <= 6 ? weekday(local) : shortDate(local);
}

/**
 * The countdown when it says more than the call's day does: "in 3h", "today",
 * "tomorrow". Null when it would only name the day ("Thu", "Oct 30").
 */
export function callAway(call: CloudEarningsCallPayload, now = Date.now()): string | null {
  const countdown = callCountdown(call, now);
  return /^(in |today$|tomorrow$)/.test(countdown) ? countdown : null;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockFormatter(timeZone: string | undefined, withDay: boolean): Intl.DateTimeFormat {
  const key = `${timeZone ?? ""}:${withDay}`;
  let formatter = clockFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
    });
    clockFormatters.set(key, formatter);
  }
  return formatter;
}

function clock(at: number, timeZone: string | undefined, withDay: boolean): string {
  const parts = Object.fromEntries(clockFormatter(timeZone, withDay).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const time = `${parts.hour}:${parts.minute}`;
  return withDay ? `${parts.weekday} ${parts.month} ${parts.day} ${time}` : time;
}

const NEW_YORK = "America/New_York";

/** Its start on this machine's clock ("22:30"), or null for a call known by its day alone. */
export function callLocalClock(call: CloudEarningsCallPayload): string | null {
  return callTimeKnown(call) ? clock(Date.parse(call.callAt!), undefined, false) : null;
}

/** Its start on New York's clock ("16:30"), or null for a call known by its day alone. */
export function callNewYorkClock(call: CloudEarningsCallPayload): string | null {
  return callTimeKnown(call) ? clock(Date.parse(call.callAt!), NEW_YORK, false) : null;
}

/** Whether this machine's clock reads New York's at every one of these starts, so one time says both. */
export function clockIsNewYork(calls: readonly CloudEarningsCallPayload[], now = Date.now()): boolean {
  const starts = [now, ...calls.filter(callTimeKnown).map((call) => Date.parse(call.callAt!))];
  return starts.every((at) => clock(at, undefined, true) === clock(at, NEW_YORK, true));
}

/**
 * When the next call starts, as its own line names it: the day and time here,
 * then New York's ("Thu Oct 22 22:30", "16:30 ET"), New York's alone when the
 * two agree ("Thu Oct 22 16:30 ET"), or the day alone ("Thu Oct 22").
 */
export function callStartText(call: CloudEarningsCallPayload, now = Date.now()): { start: string; newYork: string | null } {
  const day = callDay(call);
  if (!day) return { start: "", newYork: null };
  if (!callTimeKnown(call)) return { start: `${weekday(day)} ${shortDate(day)}`, newYork: null };
  const at = Date.parse(call.callAt!);
  if (clockIsNewYork([call], now)) return { start: `${clock(at, NEW_YORK, true)} ET`, newYork: null };
  return { start: clock(at, undefined, true), newYork: `${clock(at, NEW_YORK, false)} ET` };
}

/** The calendar's days: today when the market trades, the next session, then the rest of that week (ERN's board). */
export function calendarDays(now = Date.now()): MarketDay[] {
  return marketDays(newYorkToday(new Date(now)));
}

export type CalendarSort = { column: "time" | "ticker" | "company"; direction: "asc" | "desc" };

export const DEFAULT_CALENDAR_SORT: CalendarSort = { column: "time", direction: "asc" };

function compareRows(left: CloudEarningsCallPayload, right: CloudEarningsCallPayload, sort: CalendarSort): number {
  const order = sort.column === "ticker"
    ? left.ticker.localeCompare(right.ticker)
    : sort.column === "company"
      ? (left.companyName ?? left.ticker).localeCompare(right.companyName ?? right.ticker, undefined, { sensitivity: "base" })
      : compareCallStarts(left, right);
  return (sort.direction === "asc" ? order : -order) || compareCallStarts(left, right);
}

/**
 * The calendar's sections: one per day with calls on it, its calls in start
 * order (or the sort's), one per company and start.
 */
export function calendarSections(
  calls: readonly CloudEarningsCallPayload[],
  days: readonly MarketDay[],
  sort: CalendarSort = DEFAULT_CALENDAR_SORT,
): Array<TableSection<CloudEarningsCallPayload>> {
  const seen = new Set<string>();
  const unique = calls.filter((call) => {
    const key = `${call.ticker}:${call.callAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return days.map((day) => ({
    label: day.label,
    items: unique
      .filter((call) => {
        const on = callDay(call);
        return on !== null && on >= day.from && on <= day.to;
      })
      .sort((left, right) => compareRows(left, right, sort)),
  }));
}
