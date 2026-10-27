import { metricDescription } from "./metric-model";
import { eventAlertTarget, type EventAlertRule } from "./events";
import { alertChangeEntry, appendFiredAlert, readFiredAlerts, type AlertLogAction, type FiredAlert } from "./fired-log";
import { alertListing } from "./format";
import { isResearchAlertKind, readResearchRule } from "./research-rules";
import { readScheduledRule, scheduledEventName } from "./scheduled";
import type { AlertRule } from "./types";

/**
 * A rule as the alert log names it: its kind, the rule in words (`EWG:ARCA
 * below 40`, as a fired price alert reads) and the symbol it follows.
 */
export function alertLogRule(rule: AlertRule | EventAlertRule) {
  if ("symbol" in rule) {
    return {
      kind: rule.metric?.kind ?? "price", ruleId: rule.id,
      rule: rule.metric ? metricDescription(rule) : `${alertListing(rule)} ${rule.condition} ${rule.targetPrice}`,
      symbol: rule.symbol, ...rule.exchange ? { exchange: rule.exchange } : {},
    };
  }
  const scheduled = readScheduledRule(rule);
  const symbol = scheduled?.target.kind === "earnings" ? scheduled.target.symbol
    : isResearchAlertKind(rule.kind) ? readResearchRule(rule.kind, rule.value)?.symbol : undefined;
  return {
    kind: rule.kind, ruleId: rule.id, rule: scheduled ? scheduledEventName(scheduled.target) : eventAlertTarget(rule),
    ...symbol ? { symbol } : {},
  };
}

/** The saved log with one change more: what the pane's `usePluginState(FIRED_LOG_KEY)` setter takes. */
export function withAlertChange(saved: unknown, action: AlertLogAction, rule: AlertRule | EventAlertRule, at = Date.now()): FiredAlert[] {
  return appendFiredAlert(readFiredAlerts(saved), alertChangeEntry(action, alertLogRule(rule), at));
}
