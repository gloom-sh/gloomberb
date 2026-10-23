import type { DataProvider, EarningsEvent } from "../../../types/data-provider";
import type { CorporateActionsData, EarningsAction, EarningsDateStatus, EarningsEpsBasis } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { dateStatusFromEstimateFlag, earningsDateStatus, earningsEpsBasis } from "./earnings-report";
import { coherentEarningsValue, EARNINGS_ESTIMATE_FIELDS } from "./earnings-estimate-basis";

/**
 * The one reading of a company's report dates that `earnings`, `events`, EE,
 * ERN, OSA and the LEAPS next-earnings column share: the per-ticker
 * calendar's date resolved against the quarters the company has on record
 * (corporate actions, ERN's history), so a symbol shows the same next date,
 * timing and status everywhere.
 *
 * - A confirmed date beats an estimated one; otherwise the calendar's stands
 *   (JPM: the record's 2027-01-13 gives way to the calendar's confirmed
 *   2027-01-14).
 * - A date that has passed is reported, with the actual EPS once it is known
 *   (PEP's 2026-10-08). A report out today is reported as soon as its figure
 *   is, as same-day actuals are (META after the close).
 * - A next date only the calendar knows is added (GS's 2027-01-19).
 */

/** Two dates this close are one report under two sources: quarterly reports are some ninety days apart. */
const SAME_QUARTER_DAYS = 45;
/** An actual this close to an upcoming date is that report, out already. */
const SAME_REPORT_DAYS = 3;
const DAY_MS = 86_400_000;

/** The trading calendar's day, which report dates are on. */
export function newYorkDay(now = Date.now()): string {
  return zonedDateKey(now, "America/New_York");
}

/** The day the calendar puts a report on, YYYY-MM-DD. */
function calendarDay(event: Pick<EarningsEvent, "earningsDate">): string {
  return event.earningsDate.toISOString().slice(0, 10);
}

/**
 * A calendar event's status on `today`: reported once the report is out
 * (Gloom Cloud says so, or has its figure) or its date has passed.
 */
export function calendarStatus(
  event: Pick<EarningsEvent, "earningsDate" | "epsActual" | "isDateEstimate" | "dateStatus">,
  today: string,
): EarningsDateStatus | null {
  if (event.epsActual != null || earningsDateStatus(event.dateStatus) === "reported" || calendarDay(event) < today) return "reported";
  return dateStatusFromEstimateFlag(event.isDateEstimate);
}

/** Whether the calendar's date for a report replaces another source's: a confirmed date beats an estimated one, else the calendar's stands. */
function calendarDateWins(calendar: EarningsDateStatus | null, other: EarningsDateStatus | null): boolean {
  return calendar === "confirmed" || other !== "confirmed";
}

/** The calendar's report as a quarter on record takes it. */
interface CalendarReport {
  date: string;
  timing: "bmo" | "amc" | null;
  dateStatus: EarningsDateStatus | null;
  /** Whether the calendar's consensus is for this report; see `consensusIsReports`. */
  ownConsensus: boolean;
  /** Null when the calendar's consensus cannot be tied to the report. */
  epsEstimate: number | null;
  epsAnalysts: number | null;
  epsActual: number | null;
  epsBasis: EarningsEpsBasis | null;
  revenueEstimate: number | null;
  /** The quarter the estimate is for, YYYY-MM, when the calendar names it. */
  fiscalPeriod: string | null;
  currency: string | null;
}

/**
 * Whether the calendar's consensus is for its own report. A report out keeps
 * its date while the consensus rolls to the next quarter (PEP's 2026-10-08
 * beside December's 2.24), so once a report is out its consensus counts only
 * when something ties it to that report: the calendar's actual beside it,
 * Gloom Cloud's stored report (which says its status, and keeps the report's
 * own consensus), or a forecast quarter ending before the report date.
 */
function consensusIsReports(event: EarningsEvent, dateStatus: EarningsDateStatus | null, date: string): boolean {
  if (dateStatus !== "reported" || event.epsActual != null || event.dateStatus != null) return true;
  const periodEnd = event.estimateBasis?.epsEstimate?.periodEndDate ?? null;
  return periodEnd != null && periodEnd < date;
}

function calendarReport(event: EarningsEvent, today: string): CalendarReport {
  const date = calendarDay(event);
  const dateStatus = calendarStatus(event, today);
  const ownConsensus = consensusIsReports(event, dateStatus, date);
  const periodEnd = event.estimateBasis?.epsEstimate?.periodEndDate ?? null;
  const epsEstimate = ownConsensus ? coherentEarningsValue(event, "epsEstimate") : null;
  return {
    date,
    timing: event.timing === "BMO" ? "bmo" : event.timing === "AMC" ? "amc" : null,
    dateStatus,
    ownConsensus,
    epsEstimate,
    epsAnalysts: epsEstimate == null ? null : coherentEarningsValue(event, "epsAnalysts"),
    epsActual: event.epsActual ?? null,
    epsBasis: epsEstimate == null ? null : earningsEpsBasis(event.epsBasis),
    revenueEstimate: ownConsensus ? coherentEarningsValue(event, "revenueEstimate") : null,
    fiscalPeriod: ownConsensus && periodEnd ? periodEnd.slice(0, 7) : null,
    currency: epsEstimate == null ? null : event.estimateBasis?.epsEstimate?.currency ?? null,
  };
}

/** What the resolver reads of a quarter on record. */
interface ReportSlot {
  date: string;
  dateStatus: EarningsDateStatus | null | undefined;
  epsActual: number | null | undefined;
}

/** How one source's rows are read and rebuilt: corporate actions for events and EE, history for ERN. */
export interface ReportRowAdapter<T> {
  slot(row: T): ReportSlot;
  /** The row labelled reported, with `epsActual` when it has no figure of its own. */
  reported(row: T, epsActual: number | null): T;
  /** The calendar's report as a row: over `row` when it is the same report, else a new one. */
  fromCalendar(report: CalendarReport, row: T | null): T;
}

const isOut = (slot: ReportSlot, today: string) => slot.epsActual != null || slot.dateStatus === "reported" || slot.date < today;
const dayGap = (left: string, right: string) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / DAY_MS;

/**
 * The row the calendar's report is: for a report out, the nearest quarter on
 * record that is out, else an upcoming one days away; for an upcoming one,
 * the nearest upcoming quarter, else one out days away (out early).
 */
function calendarRowIndex(slots: readonly ReportSlot[], report: CalendarReport, today: string): number {
  const nearest = (keep: (slot: ReportSlot) => boolean, days: number) => {
    let best = -1;
    for (const [index, slot] of slots.entries()) {
      const gap = dayGap(slot.date, report.date);
      if (gap <= days && keep(slot) && (best < 0 || gap < dayGap(slots[best]!.date, report.date))) best = index;
    }
    return best;
  };
  const out = (slot: ReportSlot) => isOut(slot, today);
  const upcoming = (slot: ReportSlot) => !isOut(slot, today);
  const [first, second] = report.dateStatus === "reported" ? [out, upcoming] : [upcoming, out];
  const index = nearest(first, SAME_QUARTER_DAYS);
  return index >= 0 ? index : nearest(second, SAME_REPORT_DAYS);
}

/**
 * Quarters on record resolved against the calendar's event, with the row
 * that is the calendar's report. Past quarters read reported; the calendar's
 * report updates its row, or is added when the record has none.
 */
function resolveReportRowsWithCalendar<T>(
  rows: readonly T[],
  event: EarningsEvent | null | undefined,
  today: string,
  adapter: ReportRowAdapter<T>,
): { rows: T[]; calendarRow: T | null } {
  const resolved = rows.map((row) => {
    const slot = adapter.slot(row);
    return isOut(slot, today) && slot.dateStatus !== "reported" ? adapter.reported(row, null) : row;
  });
  if (!event) return { rows: resolved, calendarRow: null };
  const report = calendarReport(event, today);
  const index = calendarRowIndex(resolved.map(adapter.slot), report, today);
  if (index < 0) {
    const added = adapter.fromCalendar(report, null);
    return { rows: [...resolved, added], calendarRow: added };
  }
  const row = resolved[index]!;
  const slot = adapter.slot(row);
  if (isOut(slot, today)) {
    if (slot.epsActual == null && report.epsActual != null) resolved[index] = adapter.reported(row, report.epsActual);
  } else if (report.dateStatus === "reported" || calendarDateWins(report.dateStatus, earningsDateStatus(slot.dateStatus))) {
    resolved[index] = adapter.fromCalendar(report, row);
  }
  return { rows: resolved, calendarRow: resolved[index]! };
}

export function resolveReportRows<T>(rows: readonly T[], event: EarningsEvent | null | undefined, today: string, adapter: ReportRowAdapter<T>): T[] {
  return resolveReportRowsWithCalendar(rows, event, today, adapter).rows;
}

const TIME_TEXT = { bmo: "Pre Market", amc: "After Hours" } as const;

/** A row's beat, measured as Gloom Cloud measures it, once the calendar gives it a figure or an estimate it lacked. */
function withSurprise(row: EarningsAction, before: EarningsAction | null): EarningsAction {
  const { epsActual: actual, epsEstimate: estimate } = row;
  if (actual == null || estimate == null || (actual === before?.epsActual && estimate === before.epsEstimate)) return row;
  const cents = (value: number) => Math.round(value * 100) / 100;
  const { difference: _difference, surprisePercent: _surprise, ...rest } = row;
  return { ...rest, difference: cents(actual - estimate), ...(estimate !== 0 ? { surprisePercent: cents((actual - estimate) / Math.abs(estimate) * 100) } : {}) };
}

function definedFields<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

/** Corporate-actions earnings rows, as events, EE and the `earnings` resolution read them. */
const ACTION_ROWS: ReportRowAdapter<EarningsAction> = {
  slot: (row) => ({ date: row.date, dateStatus: earningsDateStatus(row.dateStatus), epsActual: row.epsActual }),
  reported: (row, epsActual) => withSurprise({ ...row, dateStatus: "reported", ...(row.epsActual == null && epsActual != null ? { epsActual } : {}) }, row),
  fromCalendar(report, row) {
    // The calendar's consensus goes with its date; without one, the record's stays.
    const estimate = report.epsEstimate != null;
    return withSurprise(definedFields<EarningsAction>({
      ...row,
      date: report.date,
      dateType: "announcement",
      time: report.timing ? TIME_TEXT[report.timing] : row?.time,
      currency: estimate ? report.currency ?? row?.currency : row?.currency,
      epsEstimate: estimate ? report.epsEstimate! : row?.epsEstimate,
      epsAnalysts: estimate ? report.epsAnalysts ?? undefined : row?.epsAnalysts,
      epsActual: report.epsActual ?? row?.epsActual,
      fiscalPeriod: row?.fiscalPeriod ?? report.fiscalPeriod ?? undefined,
      epsBasis: estimate ? report.epsBasis : row?.epsBasis,
      dateStatus: report.dateStatus ?? undefined,
    }), row);
  },
};

/** A company's corporate-actions earnings rows, newest first, resolved against its calendar event. */
export function resolveEarningsActions(earnings: readonly EarningsAction[], event: EarningsEvent | null | undefined, today: string): EarningsAction[] {
  return resolveReportRows(earnings, event, today, ACTION_ROWS).sort((left, right) => right.date.localeCompare(left.date));
}

/** A company's corporate actions with their earnings rows resolved against its calendar event. */
export function withResolvedEarnings(actions: CorporateActionsData, event: EarningsEvent | null | undefined, today: string): CorporateActionsData {
  // Without a calendar event the rows still resolve: a date gone by reads reported, as ERN reads it.
  return { ...actions, earnings: resolveEarningsActions(actions.earnings, event, today) };
}

/** The calendar's event for a symbol, as it was asked for (SAN:EPA comes back as SAN:EPA). */
export function calendarEventOf(events: readonly EarningsEvent[] | null | undefined, symbol: string): EarningsEvent | null {
  const key = symbol.trim().toUpperCase();
  return events?.find((event) => event.symbol.trim().toUpperCase() === key) ?? null;
}

/**
 * Whether the calendar event is read against its quarters on record: once
 * its date has come or its report is out, for the actual and the next
 * report, and while its date is not confirmed, which a confirmed date on
 * record beats. A confirmed date to come stands alone.
 */
function needsRecordedQuarters(event: EarningsEvent, today: string): boolean {
  return event.epsActual == null && (calendarDay(event) <= today || calendarStatus(event, today) !== "confirmed");
}

export interface ResolvedEarningsEvent extends EarningsEvent {
  /** Out, announced or projected, after resolution; null when no source says. */
  dateStatus: EarningsDateStatus | null;
}

const TIMING_OF_TEXT: Record<string, EarningsEvent["timing"]> = { "Pre Market": "BMO", "After Hours": "AMC" };

/** The calendar's event without its consensus, which is another quarter's than the report's. */
function withoutConsensus(event: EarningsEvent): EarningsEvent {
  const stripped: EarningsEvent = { ...event, epsEstimate: null, revenueEstimate: null, epsBasis: null };
  delete stripped.estimateBasis;
  for (const field of EARNINGS_ESTIMATE_FIELDS) if (stripped[field] != null) stripped[field] = null;
  return stripped;
}

const statusFlag = (status: EarningsDateStatus | null) => status === "projected" ? true : status === "confirmed" ? false : null;

/**
 * The resolved event for a row. The calendar's own report keeps every figure
 * the calendar carries (revenue, ranges, bases), but its consensus only when
 * it is the report's, and takes the row's status and, when the record has the
 * actual the calendar lacks, the record's EPS figures, measured against the
 * record's estimate. Another report on record is that row alone.
 */
function eventOfRow(event: EarningsEvent, row: EarningsAction, report: CalendarReport | null): ResolvedEarningsEvent {
  const ownDate = row.date === calendarDay(event);
  const dateStatus = earningsDateStatus(row.dateStatus);
  const earningsDate = ownDate ? event.earningsDate : new Date(`${row.date}T00:00:00.000Z`);
  const rowTiming = TIMING_OF_TEXT[row.time ?? ""];
  if (report) {
    const base = report.ownConsensus ? event : withoutConsensus(event);
    const recordFigures = row.epsActual != null && event.epsActual == null;
    return {
      ...base,
      earningsDate,
      earningsCallDate: ownDate ? event.earningsCallDate ?? null : null,
      isDateEstimate: statusFlag(dateStatus) ?? (dateStatus === "reported" ? base.isDateEstimate ?? null : null),
      epsEstimate: recordFigures ? row.epsEstimate ?? null : base.epsEstimate ?? row.epsEstimate ?? null,
      epsAnalysts: recordFigures ? row.epsAnalysts ?? null : base.epsAnalysts ?? row.epsAnalysts ?? null,
      epsActual: event.epsActual ?? row.epsActual ?? null,
      epsBasis: recordFigures ? row.epsBasis ?? null : base.epsBasis ?? row.epsBasis ?? null,
      surprise: recordFigures ? row.surprisePercent ?? null : base.surprise ?? row.surprisePercent ?? null,
      timing: (ownDate && event.timing) || rowTiming || event.timing,
      dateStatus,
    };
  }
  return {
    symbol: event.symbol,
    name: event.name,
    earningsDate,
    earningsCallDate: null,
    isDateEstimate: statusFlag(dateStatus),
    epsEstimate: row.epsEstimate ?? null,
    epsAnalysts: row.epsAnalysts ?? null,
    epsActual: row.epsActual ?? null,
    epsBasis: row.epsBasis ?? null,
    revenueEstimate: null,
    revenueActual: null,
    surprise: row.surprisePercent ?? null,
    timing: rowTiming ?? "",
    dateStatus,
  };
}

/**
 * A company's next report: the calendar's, resolved against its quarters on
 * record when they were read. Once the calendar's date has passed, the next
 * upcoming quarter on record stands in, else the report that is out, with its
 * actual and the estimate it was measured against. Without the record, a past
 * date still reads reported.
 */
export function resolveCalendarEvent(event: EarningsEvent, earnings: readonly EarningsAction[] | null | undefined, today: string): ResolvedEarningsEvent {
  const status = calendarStatus(event, today);
  if (!earnings && status !== "reported") return { ...event, dateStatus: status };
  const { rows, calendarRow } = resolveReportRowsWithCalendar(earnings ?? [], event, today, ACTION_ROWS);
  const next = rows
    .filter((row) => !isOut(ACTION_ROWS.slot(row), today))
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  const chosen = next ?? calendarRow!;
  return eventOfRow(event, chosen, chosen === calendarRow ? calendarReport(event, today) : null);
}

/** The next report date, YYYY-MM-DD, of a resolved event; null once it is out. */
export function upcomingReportDate(event: ResolvedEarningsEvent | null | undefined): string | null {
  return event && event.dateStatus !== "reported" ? calendarDay(event) : null;
}

/** A listing: the calendar's key for it (SAN:EPA) and the symbol and venue corporate actions are read by. */
export interface EarningsListing {
  key: string;
  symbol: string;
  exchange: string;
}

/** Calendar events need their quarters on record read at most this many at a time. */
const RECORD_CONCURRENCY = 4;

/**
 * Each listing's calendar event, resolved: the corporate actions of those
 * whose date has come are read for their actual and the next quarter on
 * record. A listing the calendar has nothing for is absent; one whose
 * record cannot be read resolves on the calendar alone.
 */
export async function resolveListingEvents(
  provider: Pick<DataProvider, "getCorporateActions">,
  listings: readonly EarningsListing[],
  events: readonly EarningsEvent[],
  today: string,
): Promise<Map<string, ResolvedEarningsEvent>> {
  const resolved = new Map<string, ResolvedEarningsEvent>();
  const pending = listings.flatMap((listing) => {
    const event = calendarEventOf(events, listing.key);
    return event ? [{ listing, event }] : [];
  });
  for (let index = 0; index < pending.length; index += RECORD_CONCURRENCY) {
    await Promise.all(pending.slice(index, index + RECORD_CONCURRENCY).map(async ({ listing, event }) => {
      const earnings = needsRecordedQuarters(event, today) && provider.getCorporateActions
        ? await provider.getCorporateActions(listing.symbol, listing.exchange)
          .then((actions) => actions.earnings, logFailure("earnings-calendar", "Read corporate actions for a past report date failed", null))
        : null;
      resolved.set(listing.key.toUpperCase(), resolveCalendarEvent(event, earnings, today));
    }));
  }
  return resolved;
}
