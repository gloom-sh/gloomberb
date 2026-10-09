/**
 * What keeps a pane from showing everything it has: a Pro lock on part of it,
 * or a wall that needs an account. Reports and screenshots name it, so a
 * failure says "locked" instead of a generic incomplete or empty.
 */
export type PaneAccessGate = "pro" | "sign-in";

// A Pro-gated loader reports what is locked in its errors ("Full history requires Gloom Pro").
const SIGN_IN_ERROR = /\bsign(?:ed)?[ -]?in\b|\bsignup\b|\bemail verification\b|\bverify your email\b/i;
const PRO_ERROR = /\bGloom (?:Cloud )?Pro\b|\b(?:requires?|needs?) Pro\b|\bPro access\b/;

function errorMessages(errors: unknown): string[] {
  return Array.isArray(errors) ? errors.filter((error): error is string => typeof error === "string") : [];
}

/** Why the output cannot be used as it is, as a clause: "some values need Gloom Cloud Pro (locked)". */
export function accessGateReason(gate: PaneAccessGate): string {
  return gate === "pro" ? "some values need Gloom Cloud Pro (locked)" : "it needs a Gloom Cloud sign-in";
}

/** The reason as a sentence, for a screenshot's "Reason" row. */
export function accessGateSentence(gate: PaneAccessGate): string {
  const reason = accessGateReason(gate);
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

/** The word a screenshot's status line uses in place of "empty" for a gated pane. */
export function accessGateStatus(gate: PaneAccessGate): string {
  return gate === "pro" ? "locked" : "needs sign-in";
}

/**
 * The failure for an incomplete report whose own errors name a gate, with
 * those errors saying which values; null when they name none.
 */
export function incompleteReportGateMessage(token: string, errors: unknown): string | null {
  const messages = errorMessages(errors);
  const gate = messages.some((message) => SIGN_IN_ERROR.test(message)) ? "sign-in"
    : messages.some((message) => PRO_ERROR.test(message)) ? "pro" : null;
  const detail = messages.map((message) => message.replace(/\.+$/, "")).join(". ");
  return gate ? `${token} is not bot-safe: ${accessGateReason(gate)}. ${detail}.` : null;
}
