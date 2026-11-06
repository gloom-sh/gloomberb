import { moveRuleWords } from "./move";
import { alertPriceText } from "./price-text";
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
      kind: rule.metric?.kind ?? (rule.move ? "move" : "price"), ruleId: rule.id,
      rule: rule.metric ? metricDescription(rule) : rule.move ? `${alertListing(rule)} ${moveRuleWords(rule)}`
        // The level at its instrument's precision and in its unit: below 1.33750, below 70.00p.
        : `${alertListing(rule)} ${rule.condition} ${alertPriceText(rule, rule.targetPrice).replaceAll(",", "")}`,
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
