/**
 * Shared email/password auth logic for every sign-in surface (onboarding,
 * auth dialog), kept out of React so the transitions that gate a network call
 * (validation, retry classification, username derivation) can be exercised
 * without rendering.
 */
import { apiClient, type AuthUser } from "../../../api-client";
import { t } from "../../../i18n";
import { chatController } from "../chat/controller";

export type AccountSub = "choose" | "signup" | "login" | "qr" | "signed-in";

export type AccountMode = "signup" | "login";

export type AccountChoiceId = AccountMode | "qr" | "skip";

/** Order matches the chooser list, so the selected index maps straight onto an id. */
export const ACCOUNT_CHOICE_IDS: AccountChoiceId[] = ["qr", "signup", "login", "skip"];

export interface AccountOutcome {
  mode: AccountMode;
  email: string;
}

export type AccountErrorKind = "retry" | "switch-to-login";

export interface AccountSubmitError {
  message: string;
  kind: AccountErrorKind;
}

/** Server rule; keep in sync with the cloud sign-up endpoint. */
export const MIN_ACCOUNT_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;

export function validateAccountEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return t("Enter your email address.");
  if (!EMAIL_PATTERN.test(trimmed)) return t("That email address doesn't look right.");
  return null;
}

export function validateAccountPassword(password: string, mode: AccountMode): string | null {
  if (!password) return t("Enter your password.");
  if (mode === "signup" && password.length < MIN_ACCOUNT_PASSWORD_LENGTH) {
    return t("Use at least 8 characters.");
  }
  return null;
}

/**
 * Sign-up needs a username the caller never typed. Derive a stable one from the
 * email local part; `attempt > 0` appends a suffix so a taken username can be
 * retried without bouncing the user back into the form.
 */
export function deriveUsernameFromEmail(email: string, attempt = 0): string {
  const localPart = email.trim().toLowerCase().split("@")[0] ?? "";
  let base = localPart.replace(/[^a-z0-9_]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) {
    base = `u${base}`;
  }
  const suffix = attempt > 0 ? String(attempt * 1000 + Math.floor(Math.random() * 1000)) : "";
  base = base.slice(0, USERNAME_MAX_LENGTH - suffix.length);
  const username = `${base}${suffix}`;
  return username.length >= USERNAME_MIN_LENGTH
    ? username
    : username.padEnd(USERNAME_MIN_LENGTH, "0");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "";
}

/** A taken username is our own derivation's fault, so it is worth one silent retry. */
export function isUsernameConflictError(error: unknown): boolean {
  const message = errorMessage(error);
  return /username/i.test(message) && /(taken|exists|use|unavailable|duplicate)/i.test(message);
}

/**
 * Turns an auth failure into an inline message plus what enter should do next.
 * A duplicate email is the one case where retrying the same request is useless,
 * so it routes the user into the login form instead.
 */
export function classifyAccountError(error: unknown, mode: AccountMode): AccountSubmitError {
  const message = errorMessage(error);

  if (mode === "signup" && /already/i.test(message) && /(user|email|account)/i.test(message)) {
    return { message: t("That email already has an account."), kind: "switch-to-login" };
  }
  if (mode === "login" && /(invalid|incorrect|wrong)/i.test(message)) {
    return { message: t("Email or password is incorrect."), kind: "retry" };
  }

  return {
    message: message || (mode === "signup" ? t("Could not create your account.") : t("Could not sign you in.")),
    kind: "retry",
  };
}

/**
 * Runs the sign-up or sign-in sequence every surface shares: sign-up derives a
 * username the user never typed (retrying once when the derivation collides),
 * unverified accounts get a verification email, and the captured session is
 * handed to the chat controller so it reaches plugin persistence.
 */
export async function performEmailAuth(mode: AccountMode, email: string, password: string): Promise<AuthUser> {
  let user: AuthUser;
  if (mode === "signup") {
    try {
      const username = deriveUsernameFromEmail(email);
      user = await apiClient.signUp(email, username, username, password);
    } catch (error) {
      if (!isUsernameConflictError(error)) throw error;
      const retryUsername = deriveUsernameFromEmail(email, 1);
      user = await apiClient.signUp(email, retryUsername, retryUsername, password);
    }
  } else {
    user = await apiClient.signIn(email, password);
  }
  if (!user.emailVerified) {
    await apiClient.sendVerification().catch(() => {});
  }
  chatController.clearSession();
  await chatController.refreshSession().catch(() => {});
  return user;
}

export interface AccountFormState {
  mode: AccountMode;
  email: string;
  password: string;
  fieldIdx: number;
}

export type AccountFieldAdvance =
  | { action: "invalid"; message: string }
  | { action: "next-field"; fieldIdx: number }
  | { action: "submit" };

/**
 * Decides what pressing enter inside the form does. Validation runs before the
 * field advances, so an invalid value can never reach the network call.
 */
export function advanceAccountField({ mode, email, password, fieldIdx }: AccountFormState): AccountFieldAdvance {
  if (fieldIdx <= 0) {
    const message = validateAccountEmail(email);
    return message ? { action: "invalid", message } : { action: "next-field", fieldIdx: 1 };
  }
  const message = validateAccountPassword(password, mode);
  return message ? { action: "invalid", message } : { action: "submit" };
}
