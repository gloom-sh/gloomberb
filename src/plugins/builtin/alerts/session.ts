import type { WizardStep } from "../../../types/plugin";
import type { Quote } from "../../../types/financials";
import { isRegularSessionPrint } from "../../../market-data/quotes/tick-range";
import type { AlertRule } from "./types";

const SESSIONS = [
  { value: "extended", label: "Regular and extended" },
  { value: "regular", label: "Regular hours only" },
];

export function alertSessionField(kind: "price" | "move"): WizardStep {
  return { key: `${kind}:session`, label: "Session", type: "select", defaultValue: "extended", dependsOn: { key: "kind", value: kind }, options: SESSIONS };
}

/**
 * The session an alert's readings come from. A valuation or daily technical
 * rule reads the regular session's price or settled close, never an extended
 * print, so it is regular hours only however it was saved.
 */
export function alertSessionLabel(rule: Pick<AlertRule, "regularHoursOnly" | "metric">, short = false): string {
  const regular = !!rule.regularHoursOnly || !!rule.metric;
  if (short) return regular ? "Regular only" : "Reg. + ext.";
  return SESSIONS[regular ? 1 : 0]!.label;
}

export function acceptsAlertSession(rule: Pick<AlertRule, "regularHoursOnly">, quote: Pick<Quote, "marketState" | "overnightPrice">): boolean {
  return !rule.regularHoursOnly || isRegularSessionPrint(quote);
}
