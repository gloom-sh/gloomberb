import type { TapeRange, TapeSnapshot } from "../../../api-client/tape";
import { formatUtcDayTime } from "../../../utils/utc-time";
import { tapeTimeKey } from "./model";

/**
 * A time of day as `--from` and `--to` take it: `10:30` or `10:30:15` on New
 * York's clock, the session's own, or `14:30Z` / `14:30 UTC` on UTC's.
 */
export interface TapeClock {
  /** Seconds after midnight. */
  seconds: number;
  zone: "new-york" | "utc";
}

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(et|ny|z|utc)?$/i;

export function parseTapeClock(value: string): TapeClock {
  const match = CLOCK.exec(value.trim());
  const [hours, minutes, seconds] = [match?.[1], match?.[2], match?.[3] ?? "0"].map(Number);
  if (!match || hours! > 23 || minutes! > 59 || seconds! > 59) {
    throw new Error(`${value.trim() || "An empty time"} is not a time of day: use 10:30 or 10:30:15 (New York time), or 14:30Z (UTC).`);
  }
  const zone = /^(z|utc)$/i.test(match[4] ?? "") ? "utc" : "new-york";
  return { seconds: hours! * 3600 + minutes! * 60 + seconds!, zone };
}

/** The option's value as the report reads it again: the time as typed, checked. */
export function normalizeTapeClock(value: string): string {
  parseTapeClock(value);
  return value.trim();
}

const NEW_YORK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function newYorkParts(time: number): { date: string; seconds: number } {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
}

/** The instant a New York clock time on a New York date is: EDT is four hours behind UTC, EST five. */
function newYorkInstant(date: string, seconds: number): number {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  for (const offsetHours of [4, 5]) {
    const time = midnight + (seconds + offsetHours * 3600) * 1000;
    const parts = newYorkParts(time);
    if (parts.date === date && parts.seconds === seconds) return time;
  }
  return midnight + (seconds + 5 * 3600) * 1000;
}

/** The SIP day the tape carries: 04:00 to 20:00 New York time. */
const SIP_OPEN = 4 * 3600;
const SIP_CLOSE = 20 * 3600;

/** `10:30:00 ET`. */
function newYorkClock(time: number): string {
  const { seconds } = newYorkParts(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)} ET`;
}

/** `14:30:00 UTC`. */
function utcClock(time: number): string {
  return `${new Date(time).toISOString().slice(11, 19)} UTC`;
}

/** `Fri 16 Oct 2026`. */
export function sessionDay(date: string): string {
  // Measured from 1970, the year is always written.
  return formatUtcDayTime({ time: Date.parse(`${date}T00:00:00Z`), dateOnly: true }, 0);
}

/** `10:30:00 ET (14:30:00 UTC)`. */
export function tapeMoment(time: number): string {
  return `${newYorkClock(time)} (${utcClock(time)})`;
}

/** The part of the session the tape serves now: its SIP day, up to the feed cutoff while it is still running. */
export interface ServedWindow {
  date: string;
  from: number;
  to: number;
  /** The end is the feed cutoff (now, or fifteen minutes back), not the session's close. */
  cutoff: boolean;
  delayMinutes: number;
}

export function servedWindow(snapshot: Pick<TapeSnapshot, "session" | "generatedAt" | "delaySeconds">): ServedWindow | null {
  const date = snapshot.session.date;
  if (!date) return null;
  const from = newYorkInstant(date, SIP_OPEN);
  const close = newYorkInstant(date, SIP_CLOSE);
  const cutoff = Date.parse(snapshot.generatedAt) - snapshot.delaySeconds * 1000;
  return { date, from, to: Math.min(close, cutoff), cutoff: cutoff < close, delayMinutes: Math.round(snapshot.delaySeconds / 60) };
}

/** What TAS serves, for a window it cannot read: `Fri 16 Oct 2026, 04:00:00 ET (08:00:00 UTC) to ...`. */
function servedWindowText(served: ServedWindow): string {
  const end = served.cutoff ? `${tapeMoment(served.to)}, the feed cutoff${served.delayMinutes ? ` (${served.delayMinutes} min delayed)` : ""}` : tapeMoment(served.to);
  return `${sessionDay(served.date)}, ${tapeMoment(served.from)} to ${end}`;
}

/**
 * The span `--from` and `--to` ask for on the served session's date, each
 * defaulting to that end of what is served. A bound outside it, or a `--to`
 * not after `--from`, is refused with what is served.
 */
export function tapeWindowRange(served: ServedWindow, from: TapeClock | null, to: TapeClock | null): TapeRange {
  const instant = (clock: TapeClock) => clock.zone === "utc"
    // A UTC time is on the UTC day the session's New York times fall on; 00:00 UTC is the evening before's end.
    ? Date.parse(`${new Date(served.from).toISOString().slice(0, 10)}T00:00:00Z`) + clock.seconds * 1000
    : newYorkInstant(served.date, clock.seconds);
  const start = from ? instant(from) : served.from;
  const end = to ? instant(to) : served.to;
  const outside = [from && (start < served.from || start >= served.to) ? `--from ${tapeMoment(start)}` : null,
    to && (end <= served.from || end > served.to) ? `--to ${tapeMoment(end)}` : null].filter(Boolean);
  if (outside.length) throw new Error(`${outside.join(" and ")} ${outside.length > 1 ? "are" : "is"} outside the window TAS serves: ${servedWindowText(served)}.`);
  if (end <= start) throw new Error(`--to ${tapeMoment(end)} must be after --from ${tapeMoment(start)}.`);
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** Whether a SIP stamp falls in a window: from its start, before its end. */
export function inTapeRange(timestamp: string, range: TapeRange): boolean {
  const key = tapeTimeKey(timestamp);
  return key >= tapeTimeKey(range.from) && key < tapeTimeKey(range.to);
}
