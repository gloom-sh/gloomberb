import type { EarningsTiming } from "../../../api-client/earnings";
import { formatCompact, formatNumber } from "../../../utils/format";
import { timeZoneLabel, zonedDateTimeParts, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);

export const TIMING_LABEL: Record<EarningsTiming, string> = { bmo: "BMO", dmh: "DMH", amc: "AMC" };

/** "Oct 29" */
export function shortDate(date: string): string {
  const day = utcDate(date);
  return `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
}

/** "Oct 29 '26" */
export function datedYear(date: string): string {
  return `${shortDate(date)} '${date.slice(2, 4)}`;
}

/** "Wed" */
export function weekday(date: string): string {
  return WEEKDAYS[utcDate(date).getUTCDay()]!;
}

/** Fiscal quarter end month: "Sep '26". */
export function fiscalMonth(period: string | null): string {
  if (!period) return "--";
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} '${period.slice(2, 4)}`;
}

/** An implied move, priced in either direction: "±6.1%". */
export function impliedText(move: number | null | undefined): string {
  return move == null ? "--" : `±${(move * 100).toFixed(1)}%`;
}

/** A size of move without a sign: "4.1%". */
export function moveSize(move: number | null | undefined): string {
  return move == null ? "--" : `${(Math.abs(move) * 100).toFixed(1)}%`;
}

/** A signed move or surprise: "+3.2%", "-7.4%". */
export function signedPercent(value: number | null | undefined): string {
  if (value == null) return "--";
  const shown = Number((value * 100).toFixed(1));
  return `${shown > 0 ? "+" : ""}${shown.toFixed(1)}%`;
}

export function epsText(value: number | null | undefined): string {
  return value == null ? "--" : formatNumber(value, 2);
}

export function moneyText(value: number | null | undefined): string {
  return value == null ? "--" : formatCompact(value, { fixedDecimals: true });
}

export { epsSurprise as surprise } from "../shared/earnings-report";

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
  const date = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  return `${weekday(date)} ${local.day} ${MONTHS[local.month - 1]}`;
};

/**
 * A report's timing on the reader's clock, for a reader who set a timezone:
 * in Singapore an after-close report on Monday 9 Nov is out "after close,
 * about 05:05 SGT Tue 10 Nov", which "AMC" alone does not say.
 * Null without a zone or a timing, or for a zone that keeps New York's clock.
 */
export function localReportTiming(date: string, timing: EarningsTiming | null | undefined, zone: string | null | undefined): string | null {
  if (!timing || !zone || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const times = NEW_YORK_TIMES[timing];
  let [year, month, day] = date.split("-").map(Number) as [number, number, number];
  // A report out on a weekend (Berkshire's Saturday morning) is before Monday's open.
  const weekendDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekendDay === 0 || weekendDay === 6) {
    if (timing !== "bmo") return null;
    const monday = new Date(Date.UTC(year, month - 1, day + (weekendDay === 6 ? 2 : 1)));
    [year, month, day] = [monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()];
  }
  const at = zonedWallClockToUtcMs("America/New_York", year, month, day, times.at[0], times.at[1], 0);
  if (dayText(at, zone) === dayText(at, "America/New_York") && clockText(at, zone) === clockText(at, "America/New_York")) return null;
  const label = timeZoneLabel(zone);
  if (times.until) {
    const until = zonedWallClockToUtcMs("America/New_York", year, month, day, times.until[0], times.until[1], 0);
    return `${times.words}, ${clockText(at, zone)} to ${clockText(until, zone)} ${label} ${dayText(at, zone)}`;
  }
  return `${times.words}, ${timing === "bmo" ? "by" : "about"} ${clockText(at, zone)} ${label} ${dayText(at, zone)}`;
}
