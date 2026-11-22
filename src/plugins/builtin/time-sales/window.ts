import type { TapeRange, TapeSnapshot } from "../../../api-client/tape";
import { isVenueTradingDay } from "../../../market-data/market/freshness";
import { formatUtcDayTime } from "../../../utils/utc-time";
import { tapeTimeKey } from "./model";

/**
 * A time as `--from` and `--to` take it: a time of day, `10:30` or `10:30:15`
 * on New York's clock, the session's own, or `14:30Z` / `14:30 UTC` on UTC's;
 * or a timestamp, `2026-11-20T14:30:00Z` (with an offset, or bare on New
 * York's clock), which also names its day (`instant`).
 */
export interface TapeClock {
  /** Seconds after midnight. */
  seconds: number;
  zone: "new-york" | "utc";
  /** A timestamp's own instant, which may fall on a day other than the served session's. */
  instant?: number;
  /**
   * The part of a second it names, as nine digits: a SIP stamp read on from
   * (`20:55:00.392451123`) is that print, not the second or millisecond it is in.
   */
  fraction?: string;
}

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(et|ny|z|utc)?$/i;
/** `2026-11-20T14:30:00Z`, `2026-11-20 09:30`, `2026-11-20T09:30:00.250-05:00`, `2026-11-20T20:55:00.392451123Z`. */
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[t ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)\s*(z|utc|[+-]\d{2}:?\d{2})?$/i;

export function parseTapeClock(value: string): TapeClock {
  const stamp = TIMESTAMP.exec(value.trim());
  if (stamp) return timestampClock(value, stamp[1]!, stamp[2]!, stamp[3]);
  const match = CLOCK.exec(value.trim());
  const [hours, minutes, seconds] = [match?.[1], match?.[2], match?.[3] ?? "0"].map(Number);
  if (!match || hours! > 23 || minutes! > 59 || seconds! > 59) {
    throw new Error(`${value.trim() || "An empty time"} is not a time: use 10:30 or 10:30:15 (New York time), 14:30Z (UTC), or 2026-11-20T14:30:00Z.`);
  }
  const zone = /^(z|utc)$/i.test(match[5] ?? "") ? "utc" : "new-york";
  const fraction = match[4] && !/^0+$/.test(match[4]) ? match[4].padEnd(9, "0") : undefined;
  return { seconds: hours! * 3600 + minutes! * 60 + seconds!, zone, ...(fraction ? { fraction } : {}) };
}

/** A timestamp's clock and instant: on UTC's clock with `Z` or an offset, on New York's without. */
function timestampClock(value: string, date: string, time: string, zone: string | undefined): TapeClock {
  const clock = parseTapeClock(time);
  const offset = zone && !/^(z|utc)$/i.test(zone) ? /^([+-])(\d{2}):?(\d{2})$/.exec(zone) : null;
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) {
    throw new Error(`${value.trim()} is not a time: use 10:30 or 10:30:15 (New York time), 14:30Z (UTC), or 2026-11-20T14:30:00Z.`);
  }
  if (!zone) return { ...clock, instant: newYorkInstant(date, clock.seconds) };
  const offsetSeconds = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3]) * 60) : 0;
  const instant = day + (clock.seconds - offsetSeconds) * 1000;
  return { seconds: Math.floor((instant - Date.parse(`${new Date(instant).toISOString().slice(0, 10)}T00:00:00Z`)) / 1000), zone: "utc", instant,
    ...(clock.fraction ? { fraction: clock.fraction } : {}) };
}

/**
 * A UTC stamp of a whole-second instant and the part of a second after it:
 * milliseconds as ISO writes them (`…:00.250Z`), every digit past them kept
 * (`…:00.392451123Z`), as the tape's own stamps are.
 */
function tapeInstant(time: number, fraction: string | undefined): string {
  const digits = (fraction ?? "").padEnd(9, "0");
  return `${new Date(time).toISOString().slice(0, 19)}.${digits.endsWith("000000") ? digits.slice(0, 3) : digits}Z`;
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

/** `15:55:00.392451123 ET (20:55:00.392451123 UTC)`: a print's stamp to the nanosecond, as a page ends and the next starts. */
export function exactTapeMoment(stamp: string): string {
  const key = tapeTimeKey(stamp);
  const fraction = key.slice(19, 29), time = Date.parse(`${key.slice(0, 19)}Z`);
  return `${newYorkClock(time).replace(" ET", `${fraction} ET`)} (${utcClock(time).replace(" UTC", `${fraction} UTC`)})`;
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

export function lastSessionNote(snapshot: Pick<TapeSnapshot, "session" | "generatedAt" | "delaySeconds" | "asOf">): string | null {
  const served = servedWindow(snapshot);
  if (!served) return null;
  const now = newYorkParts(Date.parse(snapshot.generatedAt));
  const observedDay = snapshot.asOf ? newYorkParts(Date.parse(snapshot.asOf)).date : served.date;
  if (observedDay > served.date) return null;
  if (now.date <= served.date && served.cutoff) return null;
  const closed = !isVenueTradingDay("NYSE", now.date) || now.seconds < SIP_OPEN || now.seconds >= SIP_CLOSE;
  return `${closed ? "Market closed; last session" : "Last available session"} ${sessionDay(served.date)}.`;
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
export function tapeWindowRange(served: ServedWindow, from: TapeClock | null, to: TapeClock | null, symbol = "<ticker>"): TapeRange {
  // A timestamp on another day than the served session's: TAS reads the latest session only; older minutes are bars.
  const elsewhere = [from, to].find((clock) => clock?.instant != null && newYorkParts(clock.instant).date !== served.date);
  if (elsewhere?.instant != null) {
    const day = newYorkParts(elsewhere.instant).date;
    throw new Error(`TAS serves the latest session only, ${sessionDay(served.date)}; ${sessionDay(day)} is not on it. `
      + `That day's 1-minute bars: fn GIP ${symbol} --session ${day} --chart-resolution 1m.`);
  }
  const instant = (clock: TapeClock) => clock.instant != null ? clock.instant : clock.zone === "utc"
    // A UTC time is on the UTC day the session's New York times fall on; 00:00 UTC is the evening before's end.
    ? Date.parse(`${new Date(served.from).toISOString().slice(0, 10)}T00:00:00Z`) + clock.seconds * 1000
    : newYorkInstant(served.date, clock.seconds);
  const start = from ? instant(from) : served.from;
  const end = to ? instant(to) : served.to;
  const outside = [from && (start < served.from || start >= served.to) ? `--from ${tapeMoment(start)}` : null,
    to && (end <= served.from || end > served.to) ? `--to ${tapeMoment(end)}` : null].filter(Boolean);
  if (outside.length) throw new Error(`${outside.join(" and ")} ${outside.length > 1 ? "are" : "is"} outside the window TAS serves: ${servedWindowText(served)}.`);
  // To the nanosecond a bound names: a window read on from a print starts at that print.
  const range = { from: tapeInstant(start, from?.fraction), to: tapeInstant(end, to?.fraction) };
  if (tapeTimeKey(range.to) <= tapeTimeKey(range.from)) throw new Error(`--to ${tapeMoment(end)} must be after --from ${tapeMoment(start)}.`);
  return range;
}

/**
 * Where a full page of a window ends, and where the next one starts. Prints
 * sharing the page's last stamp may run past it, so they leave this page and
 * the next, read from that stamp, lists them whole: no print is listed twice
 * or skipped. A page all at one stamp keeps its prints and reads on from the
 * nanosecond after, the only way past it.
 */
export function tapePageEnd<T extends { timestamp: string }>(rows: readonly T[]): { rows: T[]; next: string | null } {
  const last = rows.at(-1);
  if (!last) return { rows: [], next: null };
  const key = tapeTimeKey(last.timestamp);
  const kept = rows.filter((row) => tapeTimeKey(row.timestamp) < key);
  if (kept.length) return { rows: kept, next: key };
  const nanos = Number(key.slice(20, 29)) + 1;
  const next = nanos < 1_000_000_000 ? `${key.slice(0, 20)}${String(nanos).padStart(9, "0")}Z`
    : `${new Date(Date.parse(`${key.slice(0, 19)}Z`) + 1000).toISOString().slice(0, 20)}000000000Z`;
  return { rows: [...rows], next };
}

/** Whether a SIP stamp falls in a window: from its start, before its end. */
export function inTapeRange(timestamp: string, range: TapeRange): boolean {
  const key = tapeTimeKey(timestamp);
  return key >= tapeTimeKey(range.from) && key < tapeTimeKey(range.to);
}
