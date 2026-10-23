import type { PaneFooterSegment } from "../../../components";
import { getPublishedUsEquityCalendarDay } from "../../../market-data/published-us-sessions";

/**
 * When a short interest settlement reaches readers. FINRA's calendar follows a
 * fixed rule (Rule 4560): positions are struck on the 15th of the month, or the
 * business day before when it is not one, and on the month's last business day;
 * firms report two business days later and FINRA publishes seven business days
 * after the settlement. The dataset carries only the settlement date, so the
 * rest is read from that rule, against the US exchange holidays.
 */
const PUBLICATION_LAG_BUSINESS_DAYS = 7;
const MID_MONTH_DAY = 15;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ShortInterestSchedule {
  /** The settlement the schedule is read from, `YYYY-MM-DD`. */
  settlement: string;
  /** When FINRA published that settlement. */
  published: string;
  /** The first settlement after it. */
  nextSettlement: string;
  /** When FINRA publishes that one. */
  nextPublished: string;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseDay = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** A US business day: a weekday the exchanges are open. Years the calendar does not cover read as weekdays only. */
function isBusinessDay(ms: number): boolean {
  const weekday = new Date(ms).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return getPublishedUsEquityCalendarDay("NYSE", isoDay(ms)) !== "closed";
}

function addBusinessDays(ms: number, count: number): number {
  let day = ms;
  for (let left = count; left > 0;) {
    day += DAY_MS;
    if (isBusinessDay(day)) left -= 1;
  }
  return day;
}

/** The business day on or before `ms`. */
function businessDayOnOrBefore(ms: number): number {
  let day = ms;
  while (!isBusinessDay(day)) day -= DAY_MS;
  return day;
}

/** The two settlements of a month, in order: the 15th and the last business day. */
function monthSettlements(year: number, month: number): [number, number] {
  return [
    businessDayOnOrBefore(Date.UTC(year, month, MID_MONTH_DAY)),
    // Day 0 of the next month is this month's last day.
    businessDayOnOrBefore(Date.UTC(year, month + 1, 0)),
  ];
}

/** The first settlement strictly after `ms`. */
function settlementAfter(ms: number): number {
  const from = new Date(ms);
  for (let step = 0; step < 3; step += 1) {
    const found = monthSettlements(from.getUTCFullYear(), from.getUTCMonth() + step).find((day) => day > ms);
    if (found != null) return found;
  }
  throw new Error(`No short interest settlement follows ${isoDay(ms)}.`);
}

/** The publication dates of a settlement and of the one after it; null for a date that is not `YYYY-MM-DD`. */
export function shortInterestSchedule(settlement: string): ShortInterestSchedule | null {
  const ms = parseDay(settlement);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settlement) || !Number.isFinite(ms) || isoDay(ms) !== settlement) return null;
  const next = settlementAfter(ms);
  return {
    settlement,
    published: isoDay(addBusinessDays(ms, PUBLICATION_LAG_BUSINESS_DAYS)),
    nextSettlement: isoDay(next),
    nextPublished: isoDay(addBusinessDays(next, PUBLICATION_LAG_BUSINESS_DAYS)),
  };
}

/** `Fri 9 Oct`, with its year when it is not the settlement's: a reader sees the year once, in the settlement's own date. */
function dayText(date: string, settlement: string): string {
  const ms = parseDay(date);
  const day = new Date(ms);
  const year = date.slice(0, 4) === settlement.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`;
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}${year}`;
}

/**
 * `published Fri 9 Oct, next settlement Thu 15 Oct, published Mon 26 Oct`: what a
 * trader could see on a given day, beside the settlement date the report cites.
 */
export function shortInterestScheduleText(schedule: ShortInterestSchedule): string {
  const day = (date: string) => dayText(date, schedule.settlement);
  return `published ${day(schedule.published)}, next settlement ${day(schedule.nextSettlement)}, published ${day(schedule.nextPublished)}`;
}

/**
 * The schedule in fewer words, for a line too narrow for all of it: `published
 * Fri 9 Oct, next Mon 26 Oct`, then `published Fri 9 Oct`. When the figures
 * were published goes last.
 */
function shortInterestScheduleVariants(schedule: ShortInterestSchedule): string[] {
  const day = (date: string) => dayText(date, schedule.settlement);
  return [`published ${day(schedule.published)}, next ${day(schedule.nextPublished)}`, `published ${day(schedule.published)}`];
}

/** When FINRA published a settlement (`YYYY-MM-DD`), by the schedule rule; null for a date that is not one. */
export function shortInterestPublished(settlement: string): string | null {
  return shortInterestSchedule(settlement)?.published ?? null;
}

/** The report's freshness for the newest settlement it shows; nothing when no settlement is dated. */
export function shortInterestFreshness(
  latestSettlement: string | null | undefined,
): { schedule: string; scheduleVariants: string[]; publishedAt: string } | undefined {
  const schedule = latestSettlement ? shortInterestSchedule(latestSettlement) : null;
  return schedule
    ? { schedule: shortInterestScheduleText(schedule), scheduleVariants: shortInterestScheduleVariants(schedule), publishedAt: schedule.published }
    : undefined;
}

/**
 * The footer segment SI and SIW date their figures with: when the newest
 * settlement shown was published and when the next is due, the line `fn` and
 * `shot` carry after the settlement date, shortening as the footer narrows.
 * A capture draws its own status line in its place.
 */
export function shortInterestPublicationSegments(latestSettlement: string | null | undefined): PaneFooterSegment[] {
  const freshness = shortInterestFreshness(latestSettlement);
  if (!freshness) return [];
  const [line, ...shorter] = [freshness.schedule, ...freshness.scheduleVariants].map((text) => [{ text, tone: "muted" as const }]);
  return [{ id: "short-interest-publication", asOf: true, parts: line!, variants: shorter }];
}
