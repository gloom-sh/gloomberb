import type { GloomPluginContext } from "../../../types/plugin";
import { newYorkToday } from "../earnings/board-model";
import type { EconEvent } from "../econ/types";
import {
  expectsFigures,
  printedValue,
  releaseInstant,
  releasePrintMessage,
  releaseReminderMessage,
  releaseRowOn,
} from "./calendar-events";
import { eventAlertTarget, isScheduledEventRule, readEventAlertStores, writeEventAlertStores, EVENT_ALERT_STORE_KEYS, type EventAlertRule } from "./events";
import type { FiredAlertInput } from "./fired-log";
import {
  followsRelease,
  lookupScheduledDates,
  readScheduledRule,
  reportedResult,
  resultsLookupRange,
  scheduledAlertMessage,
  scheduledPhase,
  scheduledResultsMessage,
  scheduledTargetKey,
  scheduledToday,
  type EarningsResultRow,
  type ScheduledDateLookup,
  type ScheduledEventSources,
  type ScheduledRule,
} from "./scheduled";

/** Event dates move rarely and the sources cache for longer than this. */
const CHECK_INTERVAL_MS = 15 * 60_000;
/** The first check waits for the app to settle rather than racing its first paint. */
const FIRST_CHECK_DELAY_MS = 5_000;
/** How long after its release time a release's figures are still sent: one that prints later, or an app opened later, sends nothing. */
const PRINT_WINDOW_MS = 12 * 60 * 60_000;
/** After its release time a release is asked for every minute past the cache, as most prints land in the first minutes. */
const PRINT_POLL_MS = 60_000;
/** How long the minute asks go on before the release waits for the regular check. */
const PRINT_POLL_WINDOW_MS = 30 * 60_000;
/** The first ask after a release time, which gives the calendar a moment to fill it in. */
const FIRST_PRINT_ASK_MS = 30_000;

let checkNow: (() => void) | null = null;

/** Check at once, after a rule was added, rather than at the next interval. */
export function checkScheduledEventAlertsNow(): void {
  checkNow?.();
}

/**
 * A release's row on the date a rule follows, when it is one whose figures
 * the rule still waits for: not yet sent, and due after the rule was set (one
 * set after its time sends none, so follows the next listing at once).
 */
function awaitedRow(rule: EventAlertRule, scheduled: ScheduledRule, calendar: readonly EconEvent[] | null): EconEvent | null {
  if (!calendar || !rule.eventDate || rule.printedFor === rule.eventDate || !followsRelease(scheduled.target)) return null;
  const row = releaseRowOn(scheduled.target, rule.eventDate, calendar);
  const time = row ? releaseInstant(row) : null;
  return row && expectsFigures(row) && time != null && time >= rule.createdAt ? row : null;
}

/**
 * Looks up the next date of every active earnings, macro and calendar event
 * rule, keeps it on the rule so lists can show it, and notifies once per event
 * when its lead time is reached. An earnings rule set for results keeps the
 * report day it waits for until the actual EPS is out, then alerts with it.
 * CPI, FOMC and calendar releases alert again once their figures print, read
 * from the economic calendar: asked for every minute from the release time
 * for half an hour, then at the regular checks for up to `PRINT_WINDOW_MS`.
 * The date the rule alerted for, and the one it sent figures for, are saved
 * on it, so a restart or another device does not alert again; the next
 * event's date arms it again. Runs while the app is open; with no such rules
 * it requests nothing.
 */
export function startScheduledEventAlerts(
  ctx: Pick<GloomPluginContext, "configState" | "notify" | "showPane" | "log">,
  sources: ScheduledEventSources,
  now: () => number = Date.now,
  /** Keeps each alert sent in the device's log of fired alerts. */
  record?: (entry: FiredAlertInput) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  const read = () => readEventAlertStores((key) => ctx.configState.get<string>(key) ?? "[]");

  /** One check; the delay before the next one. */
  const check = async (): Promise<number> => {
    const { rules, error } = read();
    if (error) return CHECK_INTERVAL_MS;
    const watched = rules.filter((rule) => rule.status === "active" && isScheduledEventRule(rule));
    if (watched.length === 0) return CHECK_INTERVAL_MS;
    const at = now();
    const today = newYorkToday(new Date(at));
    const scheduledRules = watched.flatMap((rule) => {
      const scheduled = readScheduledRule(rule);
      return scheduled ? [{ rule, scheduled }] : [];
    });
    const targets = scheduledRules.map((entry) => entry.scheduled.target);

    // One calendar read per check, for the releases' dates and the figures they wait for:
    // from the cache, then past it when a release time has just passed with no figures in.
    let calendar: readonly EconEvent[] | null = null;
    let calendarError: unknown = null;
    if (sources.calendar && targets.some(followsRelease)) {
      try {
        calendar = await sources.calendar(false);
        const printing = scheduledRules.some(({ rule, scheduled }) => {
          const row = awaitedRow(rule, scheduled, calendar);
          const time = row && !row.actual ? releaseInstant(row) : null;
          return time != null && at >= time && at - time < PRINT_POLL_WINDOW_MS;
        });
        if (printing) calendar = await sources.calendar(true);
      } catch (failure) {
        calendarError = failure;
        ctx.log.warn("Economic calendar unavailable", { error: String(failure) });
      }
      if (stopped) return CHECK_INTERVAL_MS;
    }
    const lookupSources: ScheduledEventSources = sources.calendar
      ? { ...sources, calendar: async () => { if (calendar) return calendar; throw calendarError ?? new Error("The economic calendar is not available."); } }
      : sources;
    const dates = await lookupScheduledDates(targets, lookupSources, today, at);
    if (stopped) return CHECK_INTERVAL_MS;
    for (const [key, lookup] of dates) {
      if ("error" in lookup) ctx.log.warn("Event dates unavailable", { target: key, error: lookup.error });
    }
    // One read of the reports every results alert due waits for.
    const waiting = scheduledRules.flatMap(({ rule, scheduled }) => {
      const date = followedDate(rule, scheduled, dates, scheduledToday(scheduled.target, at), calendar, at);
      return scheduled.trigger === "results" && scheduled.target.kind === "earnings" && date
        && scheduledPhase(date, scheduled.leadDays, rule.firedFor, today, "results") === "due"
        ? [{ symbol: scheduled.target.symbol, date }]
        : [];
    });
    let results: readonly EarningsResultRow[] = [];
    const range = resultsLookupRange(waiting.map((entry) => entry.date));
    if (range && sources.results) {
      try {
        results = await sources.results([...new Set(waiting.map((entry) => entry.symbol))], range.from, range.to);
      } catch (error) {
        ctx.log.warn("Earnings results unavailable", { error: String(error) });
      }
      if (stopped) return CHECK_INTERVAL_MS;
    }

    // Read again: the pane or a sync may have changed the rules while the dates loaded.
    const current = read();
    if (current.error) return CHECK_INTERVAL_MS;
    let changed = false;
    let delay = CHECK_INTERVAL_MS;
    // Sent once the rules are saved: a save that fails tells no one, so the next check cannot tell twice.
    const due: { body: string; entry: FiredAlertInput; pane: string }[] = [];
    const next = current.rules.map((rule): EventAlertRule => {
      const scheduled = rule.status === "active" ? readScheduledRule(rule) : null;
      if (!scheduled) return rule;
      const { target } = scheduled;
      const ruleToday = scheduledToday(target, at);
      let updated = rule;
      const date = followedDate(rule, scheduled, dates, ruleToday, calendar, at);
      if (date !== (rule.eventDate ?? null)) {
        const { eventDate: _previous, ...rest } = rule;
        updated = date ? { ...rest, eventDate: date } : rest;
        changed = true;
      }
      const notify = (body: string, entry: Partial<FiredAlertInput>, pane = "alerts") => due.push({ body, pane, entry: {
        kind: rule.kind, ruleId: rule.id, rule: eventAlertTarget(rule), firedAt: at, value: null, detail: body, quoteAt: null, source: null, ...entry,
      } });
      // The release's row on the day followed: its time, and its figures once out.
      const row = calendar && updated.eventDate && followsRelease(target) ? releaseRowOn(target, updated.eventDate, calendar) : null;
      const time = row ? releaseInstant(row) : null;
      if (updated.eventDate && scheduledPhase(updated.eventDate, scheduled.leadDays, updated.firedFor, ruleToday, scheduled.trigger) === "due") {
        // A results alert goes off once the report it waits for has its actual EPS.
        const result = scheduled.trigger === "results" && target.kind === "earnings"
          ? reportedResult(results, target.symbol, updated.eventDate)
          : null;
        if (scheduled.trigger === "results" && !result) return updated;
        // Past its time (the app was closed through the lead day) there is nothing to remind of: its figures follow.
        if (time == null || time > at) {
          if (result && target.kind === "earnings") {
            const body = scheduledResultsMessage(target.symbol, result);
            notify(body, { value: result.epsActual ?? null, unit: "EPS", symbol: target.symbol, ...(target.exchange ? { exchange: target.exchange } : {}) });
          } else {
            const body = row && target.kind === "release"
              ? releaseReminderMessage(target, row, at)
              : scheduledAlertMessage(target, updated.eventDate, ruleToday);
            notify(body, target.kind === "earnings" ? { symbol: target.symbol, ...(target.exchange ? { exchange: target.exchange } : {}) } : {});
          }
          updated = { ...updated, firedFor: updated.eventDate };
          changed = true;
        }
      }
      // The figures, once, when they print after the rule was set and within the window.
      if (row && time != null && followsRelease(target) && updated.printedFor !== updated.eventDate && expectsFigures(row)) {
        if (row.actual && at >= time && at - time <= PRINT_WINDOW_MS && time >= rule.createdAt) {
          const body = releasePrintMessage(target, row);
          notify(body, { value: null, ...printedValue(row.actual) }, "econ-calendar");
          // The figures count as its alert for the date, as the reminder does.
          updated = { ...updated, firedFor: updated.eventDate, printedFor: updated.eventDate };
          changed = true;
        } else if (!row.actual && at < time + PRINT_WINDOW_MS) {
          // Asked for again soon after its time: every minute for half an hour, then at the regular checks.
          delay = Math.min(delay, at < time ? time - at + FIRST_PRINT_ASK_MS : at - time < PRINT_POLL_WINDOW_MS ? PRINT_POLL_MS : CHECK_INTERVAL_MS);
        }
      }
      return updated;
    });
    if (!changed || stopped) return delay;
    try {
      const written = writeEventAlertStores(current.lists, next);
      for (const key of EVENT_ALERT_STORE_KEYS) {
        if (written[key] !== undefined) await ctx.configState.set(key, written[key]);
      }
    } catch (error) {
      ctx.log.warn(due.length ? "Event alerts not saved, so not sent" : "Event dates not saved", { error: String(error) });
      return delay;
    }
    for (const { body, entry, pane } of due) {
      ctx.notify({
        body,
        type: "info",
        desktop: "always",
        persistent: true,
        action: { label: "Open", onClick: () => ctx.showPane(pane) },
      });
      record?.(entry);
    }
    return delay;
  };

  const run = async () => {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    if (timer) clearTimeout(timer);
    timer = null;
    let delay = CHECK_INTERVAL_MS;
    try {
      delay = await check();
    } catch (error) {
      if (!stopped) ctx.log.warn("Event alerts check failed", { error: String(error) });
    } finally {
      running = false;
      if (!stopped) {
        if (rerun) {
          rerun = false;
          void run();
        } else {
          timer = setTimeout(() => void run(), Math.max(1_000, delay));
        }
      }
    }
  };

  timer = setTimeout(() => void run(), FIRST_CHECK_DELAY_MS);
  const trigger = () => void run();
  checkNow = trigger;
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (checkNow === trigger) checkNow = null;
  };
}

/**
 * The event date a rule follows after a lookup: the next one found, none when
 * the lookup found none, and the one already known when it failed. A results
 * alert keeps the report day it is still waiting on, as the lookup moves to
 * the next report once that day has passed; a release keeps its day while its
 * figures are still to be sent.
 */
function followedDate(
  rule: EventAlertRule,
  scheduled: ScheduledRule,
  dates: ReadonlyMap<string, ScheduledDateLookup>,
  today: string,
  calendar: readonly EconEvent[] | null,
  now: number,
): string | null {
  const known = rule.eventDate ?? null;
  if (scheduled.trigger === "results" && known && known <= today
    && scheduledPhase(known, scheduled.leadDays, rule.firedFor, today, "results") === "due") return known;
  if (known && known <= today) {
    const row = awaitedRow(rule, scheduled, calendar);
    const time = row ? releaseInstant(row) : null;
    if (time != null && now < time + PRINT_WINDOW_MS) return known;
  }
  const lookup = dates.get(scheduledTargetKey(scheduled.target));
  return lookup && "date" in lookup ? lookup.date : known;
}
