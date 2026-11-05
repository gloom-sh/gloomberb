/**
 * Every reason a One Tap event can carry, the same fixed list the server
 * accepts: Google's prompt notification reasons, then the terminal's own.
 * Anything else Google reports is sent as `unknown_reason`. A reason added
 * here has to be accepted by the server first, or it would cost the event.
 */
const ONE_TAP_REASONS = [
  // Not displayed.
  "browser_not_supported",
  "invalid_client",
  "missing_client_id",
  "opt_out_or_no_session",
  "secure_http_required",
  "suppressed_by_user",
  "unregistered_origin",
  "unknown_reason",
  // Skipped.
  "auto_cancel",
  "user_cancel",
  "tap_outside",
  "issuing_failed",
  // Dismissed.
  "credential_returned",
  "cancel_called",
  "flow_restarted",
  // The terminal's: still snoozed after a dismissal, One Tap off on the
  // server, Google's script did not load, and why a sign-in was refused.
  "snoozed",
  "unavailable",
  "library_failed",
  "account_not_linked",
  "email_not_verified",
  "error",
] as const;

export type OneTapReason = (typeof ONE_TAP_REASONS)[number];

const KNOWN: ReadonlySet<string> = new Set(ONE_TAP_REASONS);

export function isOneTapReason(value: unknown): value is OneTapReason {
  return typeof value === "string" && KNOWN.has(value);
}
