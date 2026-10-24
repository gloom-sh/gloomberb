import { eventAlertTarget, type EventAlertRule } from "./events";
import { readScheduledRule, scheduledAlertStatus, scheduledToday } from "./scheduled";

/** Earnings, macro and calendar event rules name the event day they wait for; the rest name what they follow. */
export function ruleTarget(rule: EventAlertRule): string {
  const target = eventAlertTarget(rule);
  if (!readScheduledRule(rule)) return target;
  return `${target} · ${rule.eventDate ?? "date not known yet"}`;
}

/**
 * The state word the Events tab shows: a scheduled rule is Alerted once it has gone off for its coming
 * event, an IV level once its level was reached, until it is re-armed.
 */
export function ruleState(rule: EventAlertRule, now: number = Date.now()): "Active" | "Paused" | "Alerted" {
  const scheduled = readScheduledRule(rule);
  const status = scheduled ? scheduledAlertStatus(rule, scheduled.leadDays, scheduledToday(scheduled.target, now), scheduled.trigger)
    : rule.status === "active" && rule.kind === "iv_level" && rule.triggeredAt ? "triggered" : rule.status;
  return status === "paused" ? "Paused" : status === "triggered" ? "Alerted" : "Active";
}
