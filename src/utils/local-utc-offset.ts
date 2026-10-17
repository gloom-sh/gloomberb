import { zonedWallClockMs } from "./zoned-date-time";

/** Names for UTC itself. A machine left on one of them says nothing about where its user is. */
const UTC_ALIAS = /^(?:etc\/)?(?:utc|uct|gmt|gmt[+-]?0|greenwich|universal|zulu)$/i;

/** A zone that says where someone is: null for none, or for UTC itself. */
export function reportableTimeZone(zone: string | null | undefined): string | null {
  return zone && !UTC_ALIAS.test(zone) ? zone : null;
}

/** The zone this machine keeps its clock in, or null when it names none or names UTC itself. */
function systemTimeZone(): string | null {
  try {
    return reportableTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    // Intentional ignore: Runtimes without timezone metadata have no reportable local offset.
    return null;
  }
}

/** A zone's offset from UTC at an instant, in minutes east, daylight saving time included; null for a zone that does not exist. */
export function utcOffsetMinutesAt(timeZone: string, utcMs: number): number | null {
  if (!Number.isFinite(utcMs)) return null;
  try {
    return Math.round((zonedWallClockMs(utcMs, timeZone) - utcMs) / 60_000);
  } catch {
    // Intentional ignore: Unknown timezone names are represented by null.
    return null;
  }
}

/**
 * This machine's offset from UTC right now, the one thing chat sends about
 * where its user is (never the zone or a place). Null when the machine names
 * no zone, so nothing is reported rather than a guess.
 */
export function localUtcOffsetMinutes(utcMs = Date.now(), timeZone: string | null = systemTimeZone()): number | null {
  return timeZone ? utcOffsetMinutesAt(timeZone, utcMs) : null;
}
