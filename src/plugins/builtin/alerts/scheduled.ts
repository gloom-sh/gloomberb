// Alerts a number of days before a dated event: a company's next earnings, or
// the next CPI release or FOMC decision. The rules are event alert rules
// (`earnings_date`, `macro_event`) with the lead time in their config; this
// module is the date arithmetic and the lookup of the next event date.
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

/** What a scheduled alert follows: one US-listed company's earnings, or a US macro release. */
export type ScheduledEventTarget =
  | { kind: "earnings"; symbol: string; exchange: string }
  | { kind: "macro"; event: MacroAlertEvent };

export interface ScheduledRule {
  target: ScheduledEventTarget;
  leadDays: number;
}

/**
 * Where a scheduled alert stands on `today` (a New York calendar day):
 * `armed` before its lead time, `due` from the lead day through the event day
 * until it alerts, `fired` once it has for this event, `passed` after the
 * event day, and `unscheduled` with no event date to wait for.
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

/** The names a macro event alert takes, as the CLI spells them. */
export const MACRO_EVENT_CLI_NAMES = "CPI or FOMC";

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
): ScheduledPhase {
  if (!eventDate) return "unscheduled";
  if (today > eventDate) return "passed";
  if (firedFor === eventDate) return "fired";
  return today >= leadStartDate(eventDate, leadDays) ? "due" : "armed";
}

/** The rule's target and lead time; null for a rule that is not a scheduled event or does not read. */
export function readScheduledRule(rule: EventAlertRule): ScheduledRule | null {
  if (rule.kind !== "earnings_date" && rule.kind !== "macro_event") return null;
  const config = readResearchRule(rule.kind, rule.value);
  if (!config || typeof config.leadDays !== "number") return null;
  if (rule.kind === "macro_event") {
    return isMacroAlertEvent(config.event) ? { target: { kind: "macro", event: config.event }, leadDays: config.leadDays } : null;
  }
  return config.symbol
    ? { target: { kind: "earnings", symbol: config.symbol, exchange: config.exchange ?? "" }, leadDays: config.leadDays }
    : null;
}

/** One key per thing to look up, shared by every rule on the same event. */
export function scheduledTargetKey(target: ScheduledEventTarget): string {
  return target.kind === "earnings" ? `earnings:${target.symbol}` : `macro:${target.event}`;
}

/** "CRWV earnings", "CPI release", "FOMC decision". */
export function scheduledEventName(target: ScheduledEventTarget): string {
  return target.kind === "earnings" ? `${target.symbol} earnings` : MACRO_EVENT_NAMES[target.event];
}

/**
 * A new rule for `target`, alerting `leadDays` before it, with the event date
 * the caller looked up. Throws for a listing the rule cannot follow.
 */
export function createScheduledAlert(
  target: ScheduledEventTarget,
  leadDays: number,
  eventDate: string | null,
  now = Date.now(),
): EventAlertRule {
  const kind = target.kind === "earnings" ? "earnings_date" : "macro_event";
  const value = normalizeResearchRule(kind, target.kind === "earnings"
    ? { version: 1, symbol: target.symbol, exchange: target.exchange, leadDays }
    : { version: 1, event: target.event, leadDays });
  if (!value) {
    throw new Error(target.kind === "earnings"
      ? `Earnings alerts follow US listings, such as CRWV or AAPL:NASDAQ. ${target.exchange ? `${target.symbol}:${target.exchange}` : target.symbol} is not one.`
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

/** Re-armed: it alerts again for the event it already alerted for, and a paused rule resumes. */
export function rearmScheduledAlert(rule: EventAlertRule, now = Date.now()): EventAlertRule {
  const { firedFor: _fired, ...rest } = rule;
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
export function scheduledAlertStatus(rule: EventAlertRule, leadDays: number, today: string): "active" | "paused" | "triggered" {
  if (rule.status === "paused") return "paused";
  return scheduledPhase(rule.eventDate, leadDays, rule.firedFor, today) === "fired" ? "triggered" : "active";
}

export interface EarningsDateRow {
  symbol: string;
  earningsDate: Date;
}

/**
 * The next earnings day of `symbol` on or after `today`. The day is the UTC
 * date of the report time, the day ERN and `gloomberb earnings` show.
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
}

export type ScheduledDateLookup = { date: string | null } | { error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The next date of every target, keyed by `scheduledTargetKey`: one earnings
 * request for all the symbols, one CPI and one FOMC read. A source that fails
 * gives its targets an error and leaves the others alone.
 */
export async function lookupScheduledDates(
  targets: readonly ScheduledEventTarget[],
  sources: ScheduledEventSources,
  today: string,
): Promise<Map<string, ScheduledDateLookup>> {
  const result = new Map<string, ScheduledDateLookup>();
  const symbols = [...new Set(targets.flatMap((target) => (target.kind === "earnings" ? [target.symbol] : [])))];
  const macros = new Set(targets.flatMap((target) => (target.kind === "macro" ? [target.event] : [])));
  await Promise.all([
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
  return target.kind === "earnings"
    ? `Earnings dates for ${target.symbol} could not be loaded (${error}), so no alert was added. Check the symbol, or try again later.`
    : `The next ${MACRO_EVENT_NAMES[target.event]} date could not be loaded (${error}), so no alert was added.`;
}

/** Why no alert was added for an event with no known next date. */
export function noUpcomingEventMessage(target: ScheduledEventTarget): string {
  return target.kind === "earnings"
    ? `No upcoming earnings date is known for ${target.symbol}, so no alert was added.`
    : `No upcoming ${MACRO_EVENT_NAMES[target.event]} date is known, so no alert was added.`;
}
