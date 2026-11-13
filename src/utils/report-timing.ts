import type { EarningsTiming } from "../api-client/earnings";
import { timeZoneLabel, zonedDateTimeParts, zonedWallClockToUtcMs } from "./zoned-date-time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** When a report is out on the New York clock, as `[hour, minute]`: before the 9:30 open, or shortly after the 16:00 close. */
const NEW_YORK_TIMES: Record<EarningsTiming, { words: string; at: readonly [number, number]; until?: readonly [number, number] }> = {
  bmo: { words: "before open", at: [9, 30] },
  dmh: { words: "during market hours", at: [9, 30], until: [16, 0] },
  amc: { words: "after close", at: [16, 5] },
};

const clockText = (time: number, zone: string) => {
  const local = zonedDateTimeParts(time, zone);
  return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
};

const dayText = (time: number, zone: string) => {
  const local = zonedDateTimeParts(time, zone);
  const weekday = WEEKDAYS[new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()]!;
  return `${weekday} ${local.day} ${MONTHS[local.month - 1]}`;
};

/**
 * When a report comes out, on the reader's clock.
 *
 * A time the company announced (`releaseAt`, Berkshire's Saturday 13:00Z) is
 * that time: "at 21:00 SGT Sat 7 Nov" in Singapore, and in UTC for a reader
 * with no zone set. Otherwise, for a reader who set a timezone, the session
 * timing on their clock: in Singapore an after-close report on Monday 9 Nov
 * is out "after close, about 05:05 SGT Tue 10 Nov", which "AMC" alone does
 * not say. A weekend date has no session to place it by, so without an
 * announced time it says nothing more than its label.
 *
 * Null without either, or for a zone that keeps New York's clock.
 */
export function localReportTiming(
  date: string,
  timing: EarningsTiming | null | undefined,
  zone: string | null | undefined,
  releaseAt?: string | null,
): string | null {
  const announced = releaseAt ? Date.parse(releaseAt) : NaN;
  if (Number.isFinite(announced)) {
    const shown = zone ?? "UTC";
    return `at ${clockText(announced, shown)} ${timeZoneLabel(shown, announced)} ${dayText(announced, shown)}`;
  }
  if (!timing || !zone || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const times = NEW_YORK_TIMES[timing];
  const at = zonedWallClockToUtcMs("America/New_York", year, month, day, times.at[0], times.at[1], 0);
  if (dayText(at, zone) === dayText(at, "America/New_York") && clockText(at, zone) === clockText(at, "America/New_York")) return null;
  const label = timeZoneLabel(zone, at);
  if (times.until) {
    const until = zonedWallClockToUtcMs("America/New_York", year, month, day, times.until[0], times.until[1], 0);
    return `${times.words}, ${clockText(at, zone)} to ${clockText(until, zone)} ${label} ${dayText(at, zone)}`;
  }
  return `${times.words}, ${timing === "bmo" ? "by" : "about"} ${clockText(at, zone)} ${label} ${dayText(at, zone)}`;
}
