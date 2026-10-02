/**
 * The email/password attempt behind every sign-in form (the cloud auth form
 * and onboarding's account step), without any UI: validation before the
 * network call, one attempt at a time, and a late answer from an abandoned
 * attempt ignored. Each form keeps its own fields, layout and keys.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "../../../api-client";
import { t } from "../../../i18n";
import {
  advanceAccountField,
  classifyAccountError,
  performEmailAuth,
  validateAccountEmail,
  validateAccountPassword,
  type AccountMode,
  type AccountOutcome,
  type AccountSubmitError,
} from "./auth-model";

export type EmailAuthField = "email" | "password";

export interface EmailAuthAttemptOptions {
  mode: AccountMode;
  email: string;
  password: string;
  /**
   * Sign-up retries an email that already has an account as a login with the
   * same password before the user sees anything. Without it the duplicate
   * shows as a `switch-to-login` error that Enter follows.
   */
  loginOnDuplicateEmail?: boolean;
  /** Gives a field the keyboard: one that failed validation, or the password after the email. */
  onFocusField: (field: EmailAuthField) => void;
  /** Turns the form into a login for the same email, the password to type again. */
  onSwitchToLogin: () => void;
  /** Validation passed and the request is on its way. */
  onAttemptStart?: () => void;
  onSignedIn: (user: AuthUser, outcome: AccountOutcome) => void;
  onFailed?: (error: AccountSubmitError, mode: AccountMode) => void;
}

export interface EmailAuthAttempt {
  submitting: boolean;
  validationError: string | null;
  submitError: AccountSubmitError | null;
  setValidationError: (message: string | null) => void;
  setSubmitError: (error: AccountSubmitError | null) => void;
  clearErrors: () => void;
  /** Abandons any attempt in flight, so its answer changes nothing, and clears the errors. */
  cancel: () => void;
  /** Validates both fields, then signs up or logs in. */
  submit: () => void;
  /** Enter in a field: follows a duplicate email to login, moves on to the password, or submits. */
  submitField: (field: EmailAuthField) => void;
}

export function useEmailAuthAttempt(options: EmailAuthAttemptOptions): EmailAuthAttempt {
  const { mode, email, password, loginOnDuplicateEmail = false } = options;
  // The callbacks are read when an attempt settles, so they are the latest ones.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const attemptRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<AccountSubmitError | null>(null);

  useEffect(() => () => {
    // Unmounting abandons any in-flight attempt so a late response can't set state.
    attemptRef.current += 1;
  }, []);

  const clearErrors = useCallback(() => {
    setValidationError(null);
    setSubmitError(null);
  }, []);

  const cancel = useCallback(() => {
    attemptRef.current += 1;
    setSubmitting(false);
    clearErrors();
  }, [clearErrors]);

  const submit = useCallback(() => {
    if (submitting) return;
    const callbacks = optionsRef.current;
    const trimmedEmail = email.trim();
    const emailError = validateAccountEmail(trimmedEmail);
    if (emailError) {
      callbacks.onFocusField("email");
      setValidationError(emailError);
      return;
    }
    const passwordError = validateAccountPassword(password, mode);
    if (passwordError) {
      callbacks.onFocusField("password");
      setValidationError(passwordError);
      return;
    }

    const attemptId = attemptRef.current + 1;
    attemptRef.current = attemptId;
    setSubmitting(true);
    clearErrors();
    callbacks.onAttemptStart?.();

    void (async () => {
      let attemptedMode = mode;
      try {
        let user: AuthUser;
        try {
          user = await performEmailAuth(mode, trimmedEmail, password);
        } catch (error) {
          if (!loginOnDuplicateEmail || mode !== "signup" || classifyAccountError(error, mode).kind !== "switch-to-login") throw error;
          if (attemptRef.current !== attemptId) return;
          attemptedMode = "login";
          user = await performEmailAuth("login", trimmedEmail, password);
        }
        if (attemptRef.current !== attemptId) return;
        setSubmitting(false);
        optionsRef.current.onSignedIn(user, { mode: attemptedMode, email: trimmedEmail });
      } catch (error) {
        if (attemptRef.current !== attemptId) return;
        const fellThrough = attemptedMode !== mode;
        const failure: AccountSubmitError = fellThrough
          ? { kind: "retry", message: t("This email already has an account, and that password did not match.") }
          : classifyAccountError(error, attemptedMode);
        setSubmitting(false);
        // Stay on the same email, now clearly a login, with the password to redo.
        if (fellThrough) optionsRef.current.onSwitchToLogin();
        setSubmitError(failure);
        optionsRef.current.onFailed?.(failure, attemptedMode);
      }
    })();
  }, [clearErrors, email, loginOnDuplicateEmail, mode, password, submitting]);

  const submitField = useCallback((field: EmailAuthField) => {
    // The email already has an account: Enter carries it over to log in.
    if (submitError?.kind === "switch-to-login" && !submitting) {
      optionsRef.current.onSwitchToLogin();
      return;
    }
    const advance = advanceAccountField({
      mode,
      email: email.trim(),
      password,
      fieldIdx: field === "email" ? 0 : 1,
    });
    if (advance.action === "invalid") {
      optionsRef.current.onFocusField(field);
      setValidationError(advance.message);
      return;
    }
    if (advance.action === "next-field") {
      optionsRef.current.onFocusField("password");
      setValidationError(null);
      return;
    }
    submit();
  }, [email, mode, password, submit, submitError, submitting]);

  return {
    submitting,
    validationError,
    submitError,
    setValidationError,
    setSubmitError,
    clearErrors,
    cancel,
    submit,
    submitField,
  };
}
