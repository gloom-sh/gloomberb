/**
 * What keeps a pane from showing everything it has: a Pro lock on part of it,
 * or a wall that needs an account. Reports and screenshots name it, so a
 * failure says "locked" instead of a generic incomplete or empty.
 */
export type PaneAccessGate = "pro" | "sign-in";

// A Pro-gated loader reports what is locked in its errors ("Full history requires Gloom Pro").
const SIGN_IN_ERROR = /\bsign(?:ed)?[ -]?in\b|\bsignup\b|\bemail verification\b|\bverify your email\b/i;
const PRO_ERROR = /\bGloom (?:Cloud )?Pro\b|\b(?:requires?|needs?) Pro\b|\bPro access\b/;

/** A message that says what Gloom Pro would unlock, not what failed: reports print it under "Pro", apart from the errors. */
export function isProLock(message: string): boolean {
  return PRO_ERROR.test(message) && !SIGN_IN_ERROR.test(message);
}

function errorMessages(errors: unknown): string[] {
  return Array.isArray(errors) ? errors.filter((error): error is string => typeof error === "string") : [];
}

/** Where a free account gets Gloom Pro, as every report's Pro line ends. */
const PRO_UPGRADE_POINTER = "gloom.sh/cloud";

/** `a`, `a and b`, `a, b and c`. */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What a report's free view holds back, said once: the Pro lines its pane
 * phrases (several run on as one), else the tables it left out (`Paid funding
 * and Hourly candles need Gloom Pro`), then where to get Gloom Pro. The text
 * report prints it after `Pro:`, an export's footer after `pro:`. Null when
 * nothing is locked.
 */
export function reportGateText(locks: readonly string[], lockedTables: readonly string[] = []): string | null {
  const sentences = locks.map((lock) => lock.trim().replace(/\.+$/, "")).filter(Boolean);
  const tables = lockedTables.map((title) => title.trim()).filter(Boolean);
  if (!sentences.length && tables.length) sentences.push(`${listText(tables)} ${tables.length === 1 ? "needs" : "need"} Gloom Pro`);
  return sentences.length ? `${sentences.join(". ")} · ${PRO_UPGRADE_POINTER}` : null;
}

/** Why the output cannot be used as it is, as a clause: "some values need Gloom Cloud Pro (locked)". */
function accessGateReason(gate: PaneAccessGate): string {
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

/** The gate a report's own errors name, when they name one. */
export function errorsAccessGate(errors: unknown): PaneAccessGate | null {
  const messages = errorMessages(errors);
  return messages.some((message) => SIGN_IN_ERROR.test(message)) ? "sign-in"
    : messages.some((message) => PRO_ERROR.test(message)) ? "pro" : null;
}

/**
 * The failure for an incomplete report whose own errors name a gate, with
 * those errors saying which values; null when they name none.
 */
export function incompleteReportGateMessage(token: string, errors: unknown): string | null {
  const messages = errorMessages(errors);
  const gate = errorsAccessGate(errors);
  const detail = messages.map((message) => message.replace(/\.+$/, "")).join(". ");
  return gate ? `${token} is not bot-safe: ${accessGateReason(gate)}. ${detail}.` : null;
}
