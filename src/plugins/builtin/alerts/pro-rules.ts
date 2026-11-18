// The event rules Gloom Cloud checks only for an account with Pro, and what
// every surface says about them: ALRT's Events tab, Add Event Alert, `fn ALRT`
// and `alerts add` and `alerts list`. A leaf module, so the form's fields
// (research-builder) and the rows (event-rows) read the same words.
import { resolvePlanAccess, type PlanAccessUser } from "../../../api-client/plan-rules";

/**
 * The rules Gloom Cloud checks only for an account with Pro, as docs/usage.md marks them: options flow and an
 * IV spike. A free account saves them, and nothing checks them; signing in alone does not change that.
 */
const PRO_RULE_NAMES: Readonly<Record<string, string>> = { options_flow: "options flow", iv_spike: "IV spike" };

/** Whether a rule is checked only for an account with Gloom Cloud Pro (options flow, an IV spike). */
export function checkedOnlyWithPro(rule: { kind: string }): boolean {
  return Object.hasOwn(PRO_RULE_NAMES, rule.kind);
}

/**
 * Whether the account in hand gets its Pro rules checked: signed in with Pro. Signed in before the account has
 * loaded (`user` unknown), it is taken to, so a Pro start does not flash Needs Pro.
 */
export function checksProRules(signedIn: boolean, user: PlanAccessUser | null | undefined): boolean {
  return signedIn && (user ? resolvePlanAccess(user).hasProAccess : true);
}

/** The state of a waiting Pro rule nothing checks without Pro, as `alerts list` and its CSV write it. */
export const NEEDS_PRO = "needs Pro";

/** What is free beside a Pro rule: the option chain a flow print is of, and the price and move alerts the app checks. */
const PRO_RULE_FREE = "OMON's option chain, with each contract's volume and open interest, and price and move alerts, which the app checks, are free";

/** The Events tab's status for a selected rule that reads Needs Pro: why, and what is free. */
export const PRO_RULE_STATUS = "Checked only with Gloom Cloud Pro. Free: OMON, price and move alerts";

/** What Add Event Alert says under a Pro kind's first field, before the rule is saved. */
export const PRO_RULE_FORM_NOTE: Readonly<Record<string, string>> = {
  options_flow: `Options flow alerts are part of Gloom Cloud Pro: saved now, checked only for an account with Pro. ${PRO_RULE_FREE}.`,
  iv_spike: "IV spike alerts are part of Gloom Cloud Pro: saved now, checked only for an account with Pro. "
    + "An IV level alert on the underlying, which the app checks, OMON's option chain, and price and move alerts are free.",
};

/** "options flow", "options flow and IV spike": the Pro kinds among `rules`, for a note that names them. */
function proRuleNames(rules: readonly { kind: string }[]): string {
  const names = [...new Set(rules.flatMap((rule) => checkedOnlyWithPro(rule) ? [PRO_RULE_NAMES[rule.kind]!] : []))];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

/**
 * What a list says once about its Pro rules (options flow, an IV spike): Gloom Cloud checks them only for an
 * account with Pro. `waiting` are those nothing checks now (signed out, or on a free plan), which read Needs Pro.
 */
export function needsProNote(rules: readonly { kind: string }[], waiting: number): string {
  const names = proRuleNames(rules);
  const lead = waiting > 0
    ? `${waiting === 1 ? "1 event alert needs" : `${waiting} event alerts need`} Gloom Cloud Pro: ${names} alerts are saved, but checked only for a signed-in account with Pro.`
    : `${names.charAt(0).toUpperCase()}${names.slice(1)} alerts are checked only for an account with Gloom Cloud Pro; without it they are saved but not checked.`;
  return `${lead} ${PRO_RULE_FREE}.`;
}

/** What `alerts add` says of a Pro rule saved without Pro: nothing checks it, and what is free. */
export function savedWithoutProNote(rule: { kind: string }): string {
  return ` It needs Gloom Cloud Pro: nothing checks it without a signed-in account that has Pro. ${rule.kind === "iv_spike"
    ? "An IV level alert on the underlying, which the app checks, OMON's option chain, and price and move alerts are free."
    : `${PRO_RULE_FREE}.`}`;
}
