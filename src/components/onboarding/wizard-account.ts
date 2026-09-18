import { useCallback, useRef, useState } from "react";
import { apiClient } from "../../api-client";
import { t } from "../../i18n";
import { debugLog } from "../../utils/debug-log";
import {
  advanceAccountField,
  classifyAccountError,
  performEmailAuth,
  validateAccountEmail,
  validateAccountPassword,
  type AccountMode,
  type AccountOutcome,
  type AccountSub,
  type AccountSubmitError,
} from "../../plugins/builtin/cloud/auth-model";

const onboardingLog = debugLog.createLogger("onboarding");

export interface OnboardingAccountState {
  accountSub: AccountSub;
  accountEmail: string;
  accountPassword: string;
  accountFieldIdx: number;
  accountSubmitting: boolean;
  accountSubmitError: AccountSubmitError | null;
  accountValidationError: string | null;
  accountOutcome: AccountOutcome | null;
  setAccountEmail: (value: string) => void;
  setAccountPassword: (value: string) => void;
  focusAccountField: (index: 0 | 1) => void;
  beginAccountMode: (mode: AccountMode) => void;
  beginQrSignIn: () => void;
  completeQrSignIn: (email: string) => void;
  returnToAccountForm: () => void;
  switchToAccountLogin: () => void;
  submitAccountField: () => void;
  submitAccount: () => void;
  syncExistingAccountSession: () => void;
}

/**
 * Owns the account step's sub-state machine and the auth calls behind it.
 * Skipping never routes through here, so a failed or hung request can't keep
 * the user from finishing onboarding.
 */
export function useOnboardingAccount({
  nextStep,
  setEditingField,
}: {
  nextStep: () => void;
  setEditingField: (editing: boolean) => void;
}): OnboardingAccountState {
  const attemptRef = useRef(0);
  // The text input re-emits its value on enter, so compare before clearing an
  // error the same keypress just produced.
  const emailRef = useRef("");
  const passwordRef = useRef("");
  const [accountSub, setAccountSub] = useState<AccountSub>("signup");
  const [accountEmail, setAccountEmailValue] = useState("");
  const [accountPassword, setAccountPasswordValue] = useState("");
  const [accountFieldIdx, setAccountFieldIdx] = useState(0);
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountSubmitError, setAccountSubmitError] = useState<AccountSubmitError | null>(null);
  const [accountValidationError, setAccountValidationError] = useState<string | null>(null);
  const [accountOutcome, setAccountOutcome] = useState<AccountOutcome | null>(null);

  const clearErrors = useCallback(() => {
    setAccountSubmitError(null);
    setAccountValidationError(null);
  }, []);

  const setAccountEmail = useCallback((value: string) => {
    if (emailRef.current === value) return;
    emailRef.current = value;
    setAccountEmailValue(value);
    clearErrors();
  }, [clearErrors]);

  const setAccountPassword = useCallback((value: string) => {
    if (passwordRef.current === value) return;
    passwordRef.current = value;
    setAccountPasswordValue(value);
    clearErrors();
  }, [clearErrors]);

  const resetAccountPassword = useCallback(() => {
    passwordRef.current = "";
    setAccountPasswordValue("");
  }, []);

  const beginAccountMode = useCallback((mode: AccountMode) => {
    attemptRef.current += 1;
    clearErrors();
    setAccountSubmitting(false);
    setAccountFieldIdx(0);
    setAccountSub(mode);
    setEditingField(true);
  }, [clearErrors, setEditingField]);

  const focusAccountField = useCallback((index: 0 | 1) => {
    clearErrors();
    setAccountFieldIdx(index);
    setEditingField(true);
  }, [clearErrors, setEditingField]);

  const beginQrSignIn = useCallback(() => {
    attemptRef.current += 1;
    clearErrors();
    setAccountSubmitting(false);
    setAccountSub("qr");
    setEditingField(false);
  }, [clearErrors, setEditingField]);

  // The QR panel owns the network flow; this only records the outcome and
  // advances once the mobile app has approved the session.
  const completeQrSignIn = useCallback((email: string) => {
    attemptRef.current += 1;
    resetAccountPassword();
    setAccountSubmitting(false);
    onboardingLog.info("Onboarding account step completed", { mode: "qr" });
    setAccountOutcome({ mode: "login", email });
    setAccountSub("signed-in");
    nextStep();
  }, [nextStep, resetAccountPassword]);

  /** Back to the email form from QR or the login fall-through, ready to type. */
  const returnToAccountForm = useCallback(() => {
    attemptRef.current += 1;
    clearErrors();
    setAccountSubmitting(false);
    setAccountFieldIdx(0);
    setAccountSub("signup");
    setEditingField(true);
  }, [clearErrors, setEditingField]);

  const switchToAccountLogin = useCallback(() => {
    attemptRef.current += 1;
    clearErrors();
    setAccountSubmitting(false);
    resetAccountPassword();
    setAccountFieldIdx(1);
    setAccountSub("login");
    setEditingField(true);
  }, [clearErrors, resetAccountPassword, setEditingField]);

  const submitAccount = useCallback(() => {
    if (accountSubmitting) return;
    const mode: AccountMode = accountSub === "login" ? "login" : "signup";
    const email = accountEmail.trim();
    const password = accountPassword;

    const emailError = validateAccountEmail(email);
    if (emailError) {
      setAccountFieldIdx(0);
      setAccountValidationError(emailError);
      setEditingField(true);
      return;
    }
    const passwordError = validateAccountPassword(password, mode);
    if (passwordError) {
      setAccountFieldIdx(1);
      setAccountValidationError(passwordError);
      setEditingField(true);
      return;
    }

    const attemptId = attemptRef.current + 1;
    attemptRef.current = attemptId;
    setEditingField(false);
    setAccountSubmitting(true);
    clearErrors();

    void (async () => {
      let attemptedMode = mode;
      try {
        try {
          await performEmailAuth(mode, email, password);
        } catch (error) {
          // One form serves new and returning accounts: an email that already
          // exists is retried as a login with the same password before the
          // user sees anything.
          if (mode !== "signup" || classifyAccountError(error, mode).kind !== "switch-to-login") throw error;
          if (attemptRef.current !== attemptId) return;
          attemptedMode = "login";
          await performEmailAuth("login", email, password);
        }

        if (attemptRef.current !== attemptId) return;
        onboardingLog.info("Onboarding account step completed", { mode: attemptedMode });
        setAccountSubmitting(false);
        resetAccountPassword();
        setAccountOutcome({ mode: attemptedMode, email });
        setAccountSub("signed-in");
        nextStep();
      } catch (error) {
        if (attemptRef.current !== attemptId) return;
        const submitError = attemptedMode === "login" && mode === "signup"
          ? {
            kind: "retry" as const,
            message: t("This email already has an account, and that password did not match."),
          }
          : classifyAccountError(error, attemptedMode);
        onboardingLog.error("Onboarding account step failed", { mode: attemptedMode, error: submitError.message });
        setAccountSubmitting(false);
        setAccountSubmitError(submitError);
        if (attemptedMode !== mode) {
          // Stay on the same email, now clearly a login, with the password to redo.
          resetAccountPassword();
          setAccountFieldIdx(1);
          setAccountSub("login");
          setEditingField(true);
        }
      }
    })();
  }, [accountEmail, accountPassword, accountSub, accountSubmitting, clearErrors, nextStep, resetAccountPassword, setEditingField]);

  const submitAccountField = useCallback(() => {
    if (accountSub !== "signup" && accountSub !== "login") return;
    const advance = advanceAccountField({
      mode: accountSub,
      email: accountEmail.trim(),
      password: accountPassword,
      fieldIdx: accountFieldIdx,
    });

    if (advance.action === "invalid") {
      setAccountValidationError(advance.message);
      setEditingField(true);
      return;
    }
    if (advance.action === "next-field") {
      setAccountValidationError(null);
      setAccountFieldIdx(advance.fieldIdx);
      setEditingField(true);
      return;
    }
    submitAccount();
  }, [accountEmail, accountFieldIdx, accountPassword, accountSub, setEditingField, submitAccount]);

  const syncExistingAccountSession = useCallback(() => {
    if (accountSub === "signed-in" || !apiClient.isSignedIn()) return;
    const user = apiClient.getCurrentUser();
    setAccountOutcome((current) => current ?? {
      mode: "login",
      email: user?.email?.trim() || user?.username?.trim() || "",
    });
    setAccountSub("signed-in");
  }, [accountSub]);

  return {
    accountSub,
    accountEmail,
    accountPassword,
    accountFieldIdx,
    accountSubmitting,
    accountSubmitError,
    accountValidationError,
    accountOutcome,
    setAccountEmail,
    setAccountPassword,
    focusAccountField,
    beginAccountMode,
    beginQrSignIn,
    completeQrSignIn,
    returnToAccountForm,
    switchToAccountLogin,
    submitAccountField,
    submitAccount,
    syncExistingAccountSession,
  };
}
