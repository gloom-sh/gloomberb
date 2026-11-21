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

export function alertSessionLabel(rule: Pick<AlertRule, "regularHoursOnly">, short = false): string {
  if (short) return rule.regularHoursOnly ? "Regular only" : "Reg. + ext.";
  return SESSIONS[rule.regularHoursOnly ? 1 : 0]!.label;
}

export function acceptsAlertSession(rule: Pick<AlertRule, "regularHoursOnly">, quote: Pick<Quote, "marketState" | "overnightPrice">): boolean {
  return !rule.regularHoursOnly || isRegularSessionPrint(quote);
}
