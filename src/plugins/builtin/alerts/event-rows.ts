import { eventAlertTarget, type EventAlertRule } from "./events";
import { readScheduledRule, scheduledAlertStatus } from "./scheduled";

/** Earnings and macro event rules name the event day they wait for; the rest name what they follow. */
export function ruleTarget(rule: EventAlertRule): string {
  const target = eventAlertTarget(rule);
  if (!readScheduledRule(rule)) return target;
  return `${target} · ${rule.eventDate ?? "date not known yet"}`;
}

/** The state word the Events tab shows: a scheduled rule is Alerted once it has gone off for its coming event. */
export function ruleState(rule: EventAlertRule, today: string): "Active" | "Paused" | "Alerted" {
  const scheduled = readScheduledRule(rule);
  const status = scheduled ? scheduledAlertStatus(rule, scheduled.leadDays, today) : rule.status;
  return status === "paused" ? "Paused" : status === "triggered" ? "Alerted" : "Active";
}
