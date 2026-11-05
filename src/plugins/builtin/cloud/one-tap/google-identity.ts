/**
 * Google Identity Services, the script behind Google One Tap, as the hosted
 * terminal uses it: loaded only when a prompt is about to be asked for, never
 * at startup, and read through the few calls below.
 *
 * In browsers with FedCM (Chrome, Edge) the prompt is drawn by the browser,
 * and Google reports no display moment and no reason for a skipped one; a
 * dismissed moment keeps its reason. Elsewhere Google still reports all three
 * with their reasons. Each call is guarded, since which ones exist depends on
 * that.
 */

import { isOneTapReason, type OneTapReason } from "../../../../api-client/one-tap-reasons";

const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";

/** What Google passes the callback once someone picked an account. */
export interface GoogleCredentialResponse {
  /** The ID token, a JWT for our Google client. */
  credential?: string;
  select_by?: string;
}

/** One `prompt()` notification; which methods it has depends on FedCM. */
export interface GooglePromptNotification {
  getMomentType?(): string;
  isDisplayed?(): boolean;
  getNotDisplayedReason?(): string;
  getSkippedReason?(): string;
  getDismissedReason?(): string;
}

export interface GoogleIdConfiguration {
  client_id: string;
  callback(response: GoogleCredentialResponse): void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  context?: "signin" | "signup" | "use";
  use_fedcm_for_prompt?: boolean;
  itp_support?: boolean;
}

/** `google.accounts.id`. */
export interface GoogleIdApi {
  initialize(config: GoogleIdConfiguration): void;
  prompt(listener?: (notification: GooglePromptNotification) => void): void;
  cancel(): void;
}

export type OneTapMoment =
  | { event: "one_tap_shown" }
  | { event: "one_tap_not_shown" | "one_tap_skipped" | "one_tap_dismissed"; reason: OneTapReason };

/** Google's reason when it is one of the known ones, else `unknown_reason`. */
function reasonOf(read: (() => string) | undefined): OneTapReason {
  try {
    const reason = read?.();
    return isOneTapReason(reason) ? reason : "unknown_reason";
  } catch {
    // Intentional ignore: a method FedCM retired may throw; the moment still counts.
    return "unknown_reason";
  }
}

/** A prompt notification as the event the terminal records, with Google's reason; null for one it does not know. */
export function describeMoment(notification: GooglePromptNotification): OneTapMoment | null {
  let type: string | undefined;
  try {
    type = notification.getMomentType?.();
  } catch {
    // Intentional ignore: no moment type means nothing to record.
    return null;
  }
  if (type === "display") {
    let displayed = false;
    try {
      displayed = notification.isDisplayed?.() === true;
    } catch {
      // Intentional ignore: read as not displayed, with an unknown reason.
    }
    return displayed
      ? { event: "one_tap_shown" }
      : { event: "one_tap_not_shown", reason: reasonOf(notification.getNotDisplayedReason?.bind(notification)) };
  }
  if (type === "skipped") {
    return { event: "one_tap_skipped", reason: reasonOf(notification.getSkippedReason?.bind(notification)) };
  }
  if (type === "dismissed") {
    return { event: "one_tap_dismissed", reason: reasonOf(notification.getDismissedReason?.bind(notification)) };
  }
  return null;
}

/**
 * Whether this browser can show One Tap: it needs FedCM. Without it (Safari,
 * Firefox) Google cannot see its own sign-in from our page, so the prompt
 * never shows, and such visitors are not asked into the experiment either.
 */
export function browserSupportsOneTap(scope: { IdentityCredential?: unknown; isSecureContext?: boolean } = globalThis): boolean {
  return typeof scope.IdentityCredential === "function" && scope.isSecureContext !== false;
}

interface GoogleWindow {
  google?: { accounts?: { id?: GoogleIdApi } };
}

let loading: Promise<GoogleIdApi> | null = null;

/**
 * Adds Google's script to the page once and resolves with `google.accounts.id`.
 * A failure (blocked, offline, slower than `timeoutMs`) lets a later call try again.
 */
export function loadGoogleIdentity(doc: Document = document, timeoutMs = 10_000): Promise<GoogleIdApi> {
  const ready = () => (doc.defaultView as (Window & GoogleWindow) | null)?.google?.accounts?.id ?? null;
  const loaded = ready();
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;
  const attempt = new Promise<GoogleIdApi>((resolve, reject) => {
    const script = doc.createElement("script");
    const timer = setTimeout(() => fail(new Error("Google sign-in did not load in time")), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      script.remove();
      reject(error);
    };
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      const api = ready();
      if (api) resolve(api);
      else fail(new Error("Google sign-in loaded without its API"));
    };
    script.onerror = () => fail(new Error("Google sign-in could not load"));
    doc.head.appendChild(script);
  });
  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}
