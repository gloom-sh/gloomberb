// Alerts a number of days before a dated event: a company's next earnings, or
// a release in the economic calendar, CPI and FOMC among them. An earnings
// rule can instead go off once the report's actual EPS is out; a release also
// alerts with its figures once they print (calendar-events.ts). The rules are
// event alert rules (`earnings_date`, `macro_event`, `calendar_event`) with
// the lead time in their config; this module is the date arithmetic and the
// lookup of the next event date.
import { formatNumber } from "../../../utils/format";
import type { EconEvent } from "../econ/types";
import { newYorkToday } from "../earnings/board-model";
import { epsSurprise } from "../shared/earnings-report";
import { calendarEventLabel, nextReleaseDate, type CalendarReleaseTarget } from "./calendar-events";
import type { EventAlertRule } from "./events";
import { MACRO_EVENT_NAMES } from "./research-builder";
import {
  DEFAULT_LEAD_DAYS,
  MAX_LEAD_DAYS,
  isMacroAlertEvent,
  normalizeResearchRule,
  readResearchRule,
  type MacroAlertEvent,
} from "./research-rules";

const DAY_MS = 86_400_000;

/**
 * What a scheduled alert follows: one US-listed company's earnings, CPI or
 * FOMC, or any release in the economic calendar by its name and country.
 */
export type ScheduledEventTarget =
  | { kind: "earnings"; symbol: string; exchange: string }
  | { kind: "macro"; event: MacroAlertEvent }
  | CalendarReleaseTarget;

/** CPI, FOMC and calendar releases alert again with their figures once they print; earnings do not. */
export const followsRelease = (target: ScheduledEventTarget): target is Exclude<ScheduledEventTarget, { kind: "earnings" }> =>
  target.kind !== "earnings";

/**
 * The day a rule's dates count from: New York's for earnings, CPI and FOMC,
 * whose calendars give New York days; the UTC day for a calendar release,
 * which the economic calendar lists by its UTC day.
 */
export function scheduledToday(target: ScheduledEventTarget, now: number = Date.now()): string {
  return target.kind === "release" ? new Date(now).toISOString().slice(0, 10) : newYorkToday(new Date(now));
}

/** When a scheduled rule goes off: its lead time before the date, or (earnings only) once the results are out. */
export type ScheduledTrigger = "date" | "results";

export interface ScheduledRule {
  target: ScheduledEventTarget;
  leadDays: number;
  trigger: ScheduledTrigger;
}

/**
 * How long past its report date a results alert waits for the actual EPS:
 * an after-close report is filled in overnight, and a late one a day or two
 * later. Past it the alert lets that report go and follows the next one.
 */
const RESULTS_WAIT_DAYS = 3;

/**
 * Where a scheduled alert stands on `today` (a New York calendar day):
 * `armed` before its lead time, `due` from the lead day through the event day
 * until it alerts, `fired` once it has for this event, `passed` after the
 * event day, and `unscheduled` with no event date to wait for. A results
 * alert is due from the report day through `RESULTS_WAIT_DAYS` after it, and
 * goes off within that only once the actual EPS is out.
 */
export type ScheduledPhase = "unscheduled" | "armed" | "due" | "fired" | "passed";

/** Whole days, 1 to 14; blank is the default. Null for anything else. */
export function parseLeadDays(raw: string | number | null | undefined): number | null {
  if (raw == null) return DEFAULT_LEAD_DAYS;
  const text = String(raw).trim();
  if (!text) return DEFAULT_LEAD_DAYS;
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 && days <= MAX_LEAD_DAYS ? days : null;
}

/** `CPI`, `cpi` and `FOMC` name a macro event; anything else is not one. */
export function parseMacroEventName(raw: string | null | undefined): MacroAlertEvent | null {
  const name = raw?.trim().toLowerCase();
  return isMacroAlertEvent(name) ? name : null;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`; negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The first day the alert goes off: its lead time before the event day. */
export function leadStartDate(eventDate: string, leadDays: number): string {
  return shiftDate(eventDate, -leadDays);
}

export function scheduledPhase(
  eventDate: string | undefined,
  leadDays: number,
  firedFor: string | undefined,
  today: string,
  trigger: ScheduledTrigger = "date",
): ScheduledPhase {
  if (!eventDate) return "unscheduled";
  const results = trigger === "results";
  if (today > (results ? shiftDate(eventDate, RESULTS_WAIT_DAYS) : eventDate)) return "passed";
  if (firedFor === eventDate) return "fired";
  return today >= (results ? eventDate : leadStartDate(eventDate, leadDays)) ? "due" : "armed";
}

/** The rule's target and lead time; null for a rule that is not a scheduled event or does not read. */
export function readScheduledRule(rule: EventAlertRule): ScheduledRule | null {
  if (rule.kind !== "earnings_date" && rule.kind !== "macro_event" && rule.kind !== "calendar_event") return null;
  const config = readResearchRule(rule.kind, rule.value);
  if (!config || typeof config.leadDays !== "number") return null;
  if (rule.kind === "macro_event") {
    return isMacroAlertEvent(config.event) ? { target: { kind: "macro", event: config.event }, leadDays: config.leadDays, trigger: "date" } : null;
  }
  if (rule.kind === "calendar_event") {
    return config.event && config.country
      ? {
          target: { kind: "release", event: config.event, country: config.country, ...(config.publisher ? { publisher: config.publisher } : {}) },
          leadDays: config.leadDays,
          trigger: "date",
        }
      : null;
  }
  return config.symbol
    ? {
        target: { kind: "earnings", symbol: config.symbol, exchange: config.exchange ?? "" },
        leadDays: config.leadDays,
        trigger: config.when === "results" ? "results" : "date",
      }
    : null;
}

/** One key per thing to look up, shared by every rule on the same event. */
export function scheduledTargetKey(target: ScheduledEventTarget): string {
  if (target.kind === "release") return `release:${target.country}:${target.event.toLowerCase()}:${target.publisher ?? ""}`;
  return target.kind === "earnings" ? `earnings:${target.symbol}` : `macro:${target.event}`;
}

/** "CRWV earnings", "CPI release", "FOMC decision", "NBS Manufacturing PMI (CN)". */
export function scheduledEventName(target: ScheduledEventTarget): string {
  if (target.kind === "release") return calendarEventLabel(target);
  return target.kind === "earnings" ? `${target.symbol} earnings` : MACRO_EVENT_NAMES[target.event];
}

/**
 * "1 day before", "3 days before", "when results are out": when a rule goes
 * off, as lists say it; a release's ("1 day before and when it prints")
 * also once its figures are out.
 */
export function scheduledTriggerText(rule: Pick<ScheduledRule, "leadDays" | "trigger"> & { prints?: boolean }): string {
  if (rule.trigger === "results") return "when results are out";
  return `${rule.leadDays} day${rule.leadDays === 1 ? "" : "s"} before${rule.prints ? " and when it prints" : ""}`;
}

/**
 * A new rule for `target`, alerting `lead` days before it or, for earnings,
 * once the results are out, with the event date the caller looked up. Throws
 * for a listing the rule cannot follow.
 */
export function createScheduledAlert(
  target: ScheduledEventTarget,
  lead: number | "results",
  eventDate: string | null,
  now = Date.now(),
): EventAlertRule {
  if (target.kind !== "earnings" && lead === "results") throw new Error("Only earnings alerts can wait for results.");
  const kind = target.kind === "earnings" ? "earnings_date" : target.kind === "release" ? "calendar_event" : "macro_event";
  const timing = lead === "results" ? { when: "results" } : { leadDays: lead };
  const value = normalizeResearchRule(kind, target.kind === "earnings"
    ? { version: 1, symbol: target.symbol, exchange: target.exchange, ...timing }
    : target.kind === "release"
      ? { version: 1, event: target.event, country: target.country, ...(target.publisher ? { publisher: target.publisher } : {}), ...timing }
      : { version: 1, event: target.event, ...timing });
  if (!value) {
    throw new Error(target.kind === "earnings"
      ? `Earnings alerts follow US listings, such as CRWV or AAPL:NASDAQ. ${target.exchange ? `${target.symbol}:${target.exchange}` : target.symbol} is not one.`
      : target.kind === "release"
        ? `A calendar event alert takes the event's name, a two-letter country and 1 to ${MAX_LEAD_DAYS} days before.`
        : `Days before must be a whole number from 1 to ${MAX_LEAD_DAYS}.`);
  }
  return {
    id: crypto.randomUUID(),
    kind,
    target: "rule",
    value,
    createdAt: now,
    status: "active",
    ...(eventDate ? { eventDate } : {}),
  };
}

/** Re-armed: it alerts again for the event it already alerted for, its figures too, and a paused rule resumes. */
export function rearmScheduledAlert(rule: EventAlertRule, now = Date.now()): EventAlertRule {
  const { firedFor: _fired, printedFor: _printed, ...rest } = rule;
  return { ...rest, status: "active", createdAt: rule.status === "paused" ? now : rule.createdAt };
}

/** "Mon, Nov 9" for a calendar day. */
function formatEventDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

/** The notification: "CRWV earnings in 3 days, Mon, Nov 9", "CPI release tomorrow, Wed, Oct 14". */
export function scheduledAlertMessage(target: ScheduledEventTarget, eventDate: string, today: string): string {
  const days = daysBetween(today, eventDate);
  const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `${scheduledEventName(target)} ${when}, ${formatEventDay(eventDate)}`;
}

/** A list's state word: paused, active, or triggered while it has alerted for the coming event. */
export function scheduledAlertStatus(
  rule: EventAlertRule,
  leadDays: number,
  today: string,
  trigger: ScheduledTrigger = "date",
): "active" | "paused" | "triggered" {
  if (rule.status === "paused") return "paused";
  return scheduledPhase(rule.eventDate, leadDays, rule.firedFor, today, trigger) === "fired" ? "triggered" : "active";
}

/** A company's report as ERN has it: its day and, once out, the actual EPS. */
export interface EarningsResultRow {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
}

/**
 * The report `symbol` was waited for on `eventDate`, once its actual EPS is
 * out: the reported row nearest that day, from a few days before it (a date
 * moved up) through `RESULTS_WAIT_DAYS` after. Null while it is not out.
 */
export function reportedResult(rows: readonly EarningsResultRow[], symbol: string, eventDate: string): EarningsResultRow | null {
  const wanted = symbol.trim().toUpperCase();
  const from = shiftDate(eventDate, -RESULTS_WAIT_DAYS);
  const to = shiftDate(eventDate, RESULTS_WAIT_DAYS);
  return rows
    .filter((row) => row.symbol.trim().toUpperCase() === wanted && row.epsActual != null && Number.isFinite(row.epsActual)
      && row.date >= from && row.date <= to)
    .sort((left, right) => Math.abs(daysBetween(eventDate, left.date)) - Math.abs(daysBetween(eventDate, right.date)))[0] ?? null;
}

type ResultsRead = (symbols: string[]) => Promise<readonly EarningsResultRow[]>;

/**
 * The reports results alerts wait on, from ERN's board and, for each symbol
 * the board has no actual EPS for (a listing the stored calendar does not
 * cover, or the board unreadable), the per-ticker calendar. Either read
 * failing leaves the other's rows; only both failing, or the board failing
 * with no other read, is an error.
 */
export async function readEarningsResults(
  symbols: readonly string[],
  board: ResultsRead,
  calendar: ResultsRead | null,
): Promise<EarningsResultRow[]> {
  const [fromBoard] = await Promise.allSettled([board([...symbols])]);
  const rows = fromBoard.status === "fulfilled" ? [...fromBoard.value] : [];
  const reported = new Set(rows.filter((row) => row.epsActual != null).map((row) => row.symbol.trim().toUpperCase()));
  const missing = symbols.filter((symbol) => !reported.has(symbol.trim().toUpperCase()));
  if (missing.length === 0 || !calendar) {
    if (fromBoard.status === "rejected") throw fromBoard.reason;
    return rows;
  }
  const [fromCalendar] = await Promise.allSettled([calendar(missing)]);
  if (fromCalendar.status === "fulfilled") return [...rows, ...fromCalendar.value];
  if (fromBoard.status === "rejected") throw fromBoard.reason;
  return rows;
}

/** The days to read reports over for results alerts waiting on `eventDates`. */
export function resultsLookupRange(eventDates: readonly string[]): { from: string; to: string } | null {
  const sorted = [...eventDates].sort();
  return sorted.length === 0 ? null : { from: shiftDate(sorted[0]!, -RESULTS_WAIT_DAYS), to: shiftDate(sorted.at(-1)!, RESULTS_WAIT_DAYS) };
}

/** The notification once results are out: "CRWV reported EPS 0.12 vs 0.10 expected (+20.0%)". */
export function scheduledResultsMessage(symbol: string, result: Pick<EarningsResultRow, "epsActual" | "epsEstimate">): string {
  const actual = `${symbol} reported EPS ${formatNumber(result.epsActual ?? undefined, 2)}`;
  if (result.epsEstimate == null) return actual;
  const surprise = epsSurprise(result.epsActual, result.epsEstimate);
  const shown = surprise == null ? null : Number((surprise * 100).toFixed(1));
  return `${actual} vs ${formatNumber(result.epsEstimate, 2)} expected${shown == null ? "" : ` (${shown > 0 ? "+" : ""}${shown.toFixed(1)}%)`}`;
}

export interface EarningsDateRow {
  symbol: string;
  earningsDate: Date;
}

/**
 * The next earnings day of `symbol` on or after `today`. The day is the UTC
 * date of the report time, the day ERN and `gloom earnings` show.
 */
export function nextEarningsDate(events: readonly EarningsDateRow[], symbol: string, today: string): string | null {
  const wanted = symbol.trim().toUpperCase();
  const dates = events
    .filter((event) => event.symbol?.trim().toUpperCase() === wanted && Number.isFinite(event.earningsDate?.getTime()))
    .map((event) => event.earningsDate.toISOString().slice(0, 10))
    .filter((date) => date >= today)
    .sort();
  return dates[0] ?? null;
}

/** The CPI board's release status and, when the server sends it, the published release calendar. */
export interface CpiReleaseCalendar {
  release: { nextReleaseAt: string | null };
  schedule?: ReadonlyArray<{ date?: unknown }>;
}

const newYorkDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const isDateKey = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The next CPI release day on or after `today`, from the BLS calendar or the board's next release. */
export function nextCpiReleaseDate(board: CpiReleaseCalendar, today: string): string | null {
  const next = board.release.nextReleaseAt && Number.isFinite(Date.parse(board.release.nextReleaseAt))
    ? newYorkDay.format(new Date(board.release.nextReleaseAt))
    : null;
  const scheduled = (Array.isArray(board.schedule) ? board.schedule : []).map((entry) => entry?.date).filter(isDateKey);
  return [...scheduled, ...(next ? [next] : [])].filter((date) => date >= today).sort()[0] ?? null;
}

/** The next FOMC decision day on or after `today`, from the meeting calendar. */
function nextFomcDate(meetings: ReadonlyArray<{ date: string }>, today: string): string | null {
  return meetings.map((meeting) => meeting.date).filter(isDateKey).filter((date) => date >= today).sort()[0] ?? null;
}

/** Where the next event dates come from; the app and the CLI pass the data they already load. */
export interface ScheduledEventSources {
  earnings(symbols: string[]): Promise<readonly EarningsDateRow[]>;
  cpi(): Promise<CpiReleaseCalendar>;
  fomc(): Promise<ReadonlyArray<{ date: string }>>;
  /**
   * The economic calendar ECO lists: the dates of calendar releases, and the
   * figures every release alert sends once they print. `force` asks past a
   * fresh cache, while a print is due.
   */
  calendar?(force?: boolean): Promise<readonly EconEvent[]>;
  /** The reports of `symbols` from `from` to `to`, actual EPS included once out; results alerts read it. */
  results?(symbols: string[], from: string, to: string): Promise<readonly EarningsResultRow[]>;
}

export type ScheduledDateLookup = { date: string | null } | { error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The next date of every target, keyed by `scheduledTargetKey`: one earnings
 * request for all the symbols, one CPI, one FOMC and one calendar read. A
 * source that fails gives its targets an error and leaves the others alone.
 * `today` is New York's day; a calendar release follows its next row still
 * to come at `now`.
 */
export async function lookupScheduledDates(
  targets: readonly ScheduledEventTarget[],
  sources: ScheduledEventSources,
  today: string,
  now: number = Date.now(),
): Promise<Map<string, ScheduledDateLookup>> {
  const result = new Map<string, ScheduledDateLookup>();
  const symbols = [...new Set(targets.flatMap((target) => (target.kind === "earnings" ? [target.symbol] : [])))];
  const macros = new Set(targets.flatMap((target) => (target.kind === "macro" ? [target.event] : [])));
  const releases = targets.filter((target): target is CalendarReleaseTarget => target.kind === "release");
  const readCalendar = sources.calendar?.bind(sources) ?? (() => Promise.reject(new Error("The economic calendar is not available.")));
  await Promise.all([
    releases.length === 0 ? null : readCalendar().then(
      (events) => { for (const target of releases) result.set(scheduledTargetKey(target), { date: nextReleaseDate(events, target, now) }); },
      (error) => { for (const target of releases) result.set(scheduledTargetKey(target), { error: errorText(error) }); },
    ),
    symbols.length === 0 ? null : sources.earnings(symbols).then(
      (events) => { for (const symbol of symbols) result.set(`earnings:${symbol}`, { date: nextEarningsDate(events, symbol, today) }); },
      (error) => { for (const symbol of symbols) result.set(`earnings:${symbol}`, { error: errorText(error) }); },
    ),
    !macros.has("cpi") ? null : sources.cpi().then(
      (board) => { result.set("macro:cpi", { date: nextCpiReleaseDate(board, today) }); },
      (error) => { result.set("macro:cpi", { error: errorText(error) }); },
    ),
    !macros.has("fomc") ? null : sources.fomc().then(
      (meetings) => { result.set("macro:fomc", { date: nextFomcDate(meetings, today) }); },
      (error) => { result.set("macro:fomc", { error: errorText(error) }); },
    ),
  ]);
  return result;
}

/** Why no alert was added when the next date could not be looked up. */
export function eventDateUnavailableMessage(target: ScheduledEventTarget, error: string): string {
  if (target.kind === "release") return `The economic calendar could not be loaded (${error}), so no alert was added.`;
  return target.kind === "earnings"
    ? `Earnings dates for ${target.symbol} could not be loaded (${error}), so no alert was added. Check the symbol, or try again later.`
    : `The next ${MACRO_EVENT_NAMES[target.event]} date could not be loaded (${error}), so no alert was added.`;
}

/** Why no alert was added for an event with no known next date. */
export function noUpcomingEventMessage(target: ScheduledEventTarget): string {
  if (target.kind === "release") return `The economic calendar lists no upcoming ${calendarEventLabel(target)}, so no alert was added.`;
  return target.kind === "earnings"
    ? `No upcoming earnings date is known for ${target.symbol}, so no alert was added.`
    : `No upcoming ${MACRO_EVENT_NAMES[target.event]} date is known, so no alert was added.`;
}
