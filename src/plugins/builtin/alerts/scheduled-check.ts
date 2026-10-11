import type { GloomPluginContext } from "../../../types/plugin";
import { newYorkToday } from "../earnings/board-model";
import { EVENT_ALERTS_KEY, isScheduledEventRule, readEventAlerts, type EventAlertRule } from "./events";
import {
  lookupScheduledDates,
  readScheduledRule,
  scheduledAlertMessage,
  scheduledPhase,
  scheduledTargetKey,
  type ScheduledEventSources,
} from "./scheduled";

/** Event dates move rarely and the sources cache for longer than this. */
const CHECK_INTERVAL_MS = 15 * 60_000;
/** The first check waits for the app to settle rather than racing its first paint. */
const FIRST_CHECK_DELAY_MS = 5_000;

let checkNow: (() => void) | null = null;

/** Check at once, after a rule was added, rather than at the next interval. */
export function checkScheduledEventAlertsNow(): void {
  checkNow?.();
}

/**
 * Looks up the next date of every active earnings and macro event rule, keeps
 * it on the rule so lists can show it, and notifies once per event when its
 * lead time is reached. The date the rule alerted for is saved on it, so a
 * restart or another device does not alert again; the next event's date arms
 * it again. Runs while the app is open; with no such rules it requests nothing.
 */
export function startScheduledEventAlerts(
  ctx: Pick<GloomPluginContext, "configState" | "notify" | "showPane" | "log">,
  sources: ScheduledEventSources,
  now: () => number = Date.now,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  const read = () => readEventAlerts(ctx.configState.get<string>(EVENT_ALERTS_KEY) ?? "[]");

  const check = async () => {
    const { rules, error } = read();
    if (error) return;
    const watched = rules.filter((rule) => rule.status === "active" && isScheduledEventRule(rule));
    if (watched.length === 0) return;
    const today = newYorkToday(new Date(now()));
    const targets = watched.flatMap((rule) => readScheduledRule(rule)?.target ?? []);
    const dates = await lookupScheduledDates(targets, sources, today);
    if (stopped) return;
    for (const [key, lookup] of dates) {
      if ("error" in lookup) ctx.log.warn("Event dates unavailable", { target: key, error: lookup.error });
    }

    // Read again: the pane or a sync may have changed the rules while the dates loaded.
    const current = read();
    if (current.error) return;
    let changed = false;
    const next = current.rules.map((rule): EventAlertRule => {
      const scheduled = rule.status === "active" ? readScheduledRule(rule) : null;
      if (!scheduled) return rule;
      let updated = rule;
      const lookup = dates.get(scheduledTargetKey(scheduled.target));
      // A failed lookup keeps the date already known.
      if (lookup && "date" in lookup && lookup.date !== (rule.eventDate ?? null)) {
        const { eventDate: _previous, ...rest } = rule;
        updated = lookup.date ? { ...rest, eventDate: lookup.date } : rest;
        changed = true;
      }
      if (updated.eventDate && scheduledPhase(updated.eventDate, scheduled.leadDays, updated.firedFor, today) === "due") {
        ctx.notify({
          body: scheduledAlertMessage(scheduled.target, updated.eventDate, today),
          type: "info",
          desktop: "always",
          persistent: true,
          action: { label: "Open", onClick: () => ctx.showPane("alerts") },
        });
        updated = { ...updated, firedFor: updated.eventDate };
        changed = true;
      }
      return updated;
    });
    if (changed && !stopped) await ctx.configState.set(EVENT_ALERTS_KEY, JSON.stringify(next));
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
    try {
      await check();
    } catch (error) {
      if (!stopped) ctx.log.warn("Event alerts check failed", { error: String(error) });
    } finally {
      running = false;
      if (!stopped) {
        if (rerun) {
          rerun = false;
          void run();
        } else {
          timer = setTimeout(() => void run(), CHECK_INTERVAL_MS);
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
