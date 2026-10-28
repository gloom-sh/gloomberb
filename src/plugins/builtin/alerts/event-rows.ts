import { eventAlertTarget, type EventAlertRule } from "./events";
import { readScheduledRule, scheduledAlertStatus, scheduledToday } from "./scheduled";

/** Earnings, macro and calendar event rules name the event day they wait for; the rest name what they follow. */
export function ruleTarget(rule: EventAlertRule): string {
  const target = eventAlertTarget(rule);
  if (!readScheduledRule(rule)) return target;
  return `${target} · ${rule.eventDate ?? "date not known yet"}`;
}

/**
 * Whether a rule is checked only for a signed-in account: Gloom Cloud checks every event rule but an IV level
 * and an earnings, CPI, FOMC or calendar date, which the app reads itself, signed in or not, and the app reads
 * catalysts only with a session. Signed out, such a rule never goes off.
 */
export function checkedWhenSignedIn(rule: EventAlertRule): boolean {
  return rule.kind !== "iv_level" && !readScheduledRule(rule);
}

/** The state of a waiting rule nothing checks while signed out, as `alerts list` and its CSV write it. */
export const NEEDS_SIGN_IN = "needs sign-in";

/** What a list of rules says once when some of them need sign-in: what to do about it. */
export function needsSignInNote(count: number): string {
  return `${count === 1 ? "1 event alert needs" : `${count} event alerts need`} sign-in: ${count === 1 ? "it is" : "they are"} checked only for a signed-in account. `
    + "Open the app (gloom) and log in or sign up free from the command bar (Ctrl+P, Log In or Sign Up).";
}

/**
 * The state word the Events tab shows: a scheduled rule is Alerted once it has gone off for its coming
 * event, an IV level once its level was reached, until it is re-armed. Signed out, a waiting rule only a
 * signed-in account gets checked needs sign-in.
 */
export function ruleState(rule: EventAlertRule, now: number = Date.now(), signedIn = true): "Active" | "Paused" | "Alerted" | "Needs sign-in" {
  const scheduled = readScheduledRule(rule);
  const status = scheduled ? scheduledAlertStatus(rule, scheduled.leadDays, scheduledToday(scheduled.target, now), scheduled.trigger)
    : rule.status === "active" && rule.kind === "iv_level" && rule.triggeredAt ? "triggered" : rule.status;
  if (status === "paused") return "Paused";
  if (status === "triggered") return "Alerted";
  return !signedIn && checkedWhenSignedIn(rule) ? "Needs sign-in" : "Active";
}
