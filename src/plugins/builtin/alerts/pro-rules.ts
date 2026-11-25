// The event rules Gloom Cloud checks only for an account with Pro, and what
// every surface says about them: ALRT's Events tab, Add Event Alert, `fn ALRT`
// and `alerts add` and `alerts list`. A leaf module, so the form's fields
// (research-builder) and the rows (event-rows) read the same words, which
// live in shared/options-pro-copy beside the FLOW wall's.
import { resolvePlanAccess, type PlanAccessUser } from "../../../api-client/plan-rules";
import { proAlertFormNote, proAlertFree, proAlertSavedNote, proAlertsFree } from "../shared/options-pro-copy";

/**
 * The rules checked only for an account with Pro. A free account saves them, and signing in alone does not change that.
 */
const PRO_RULE_NAMES: Readonly<Record<string, string>> = {
  options_flow: "options flow",
  iv_spike: "IV spike",
  catalyst: "catalyst",
  hiring_move: "hiring move",
  buyback: "buyback",
  perps_threshold: "perpetuals threshold",
};

/** Whether a rule is checked only for an account with Gloom Cloud Pro. */
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

/** The Events tab's status for a selected rule that reads Needs Pro: what is free instead, the row saying it needs Pro. */
export function proRuleStatus(rule: { kind: string }): string {
  return proAlertFree(rule.kind);
}

/** What Add Event Alert says under a Pro kind's first field, before the rule is saved; null for any other kind. */
export function proRuleFormNote(kind: string): string | null {
  return checkedOnlyWithPro({ kind }) ? proAlertFormNote(kind) : null;
}

/** "options flow", "options flow and IV spike": the Pro kinds among `rules`, for a note that names them. */
function proRuleNames(rules: readonly { kind: string }[]): string {
  const names = [...new Set(rules.flatMap((rule) => checkedOnlyWithPro(rule) ? [PRO_RULE_NAMES[rule.kind]!] : []))];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

/**
 * What a list says once about its Pro rules (options flow, an IV spike): Gloom Cloud checks them only with Pro.
 * `waiting` are those nothing checks now (signed out, or on a free plan), which read Needs Pro.
 */
export function needsProNote(rules: readonly { kind: string }[], waiting: number): string {
  const names = proRuleNames(rules);
  const lead = waiting > 0
    ? `${waiting === 1 ? "1 event alert needs" : `${waiting} event alerts need`} Pro (${names}).`
    : `${names.charAt(0).toUpperCase()}${names.slice(1)} alerts are checked only with Pro.`;
  return `${lead} ${proAlertsFree(rules.map((rule) => rule.kind))}`;
}

/** What `alerts add` and the saved toast add after a Pro rule saved without Pro: checked only with Pro, and what is free. */
export function savedWithoutProNote(rule: { kind: string }): string {
  return ` ${proAlertSavedNote(rule.kind)}`;
}
