import { useCallback, useRef, useState } from "react";
import { apiClient } from "../../api-client";
import { debugLog } from "../../utils/debug-log";
import {
  type AccountMode,
  type AccountOutcome,
  type AccountSub,
  type AccountSubmitError,
} from "../../plugins/builtin/cloud/auth-model";
import { useEmailAuthAttempt } from "../../plugins/builtin/cloud/email-auth-attempt";

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
  syncExistingAccountSession: () => void;
}

/**
 * Owns the account step's sub-state machine; the email attempt itself is the
 * one the cloud auth form runs. Skipping never routes through here, so a
 * failed or hung request can't keep the user from finishing onboarding.
 */
export function useOnboardingAccount({
  nextStep,
  setEditingField,
}: {
  nextStep: () => void;
  setEditingField: (editing: boolean) => void;
}): OnboardingAccountState {
  // The text input re-emits its value on enter, so compare before clearing an
  // error the same keypress just produced.
  const emailRef = useRef("");
  const passwordRef = useRef("");
  const [accountSub, setAccountSub] = useState<AccountSub>("signup");
  const [accountEmail, setAccountEmailValue] = useState("");
  const [accountPassword, setAccountPasswordValue] = useState("");
  const [accountFieldIdx, setAccountFieldIdx] = useState(0);
  const [accountOutcome, setAccountOutcome] = useState<AccountOutcome | null>(null);

  const auth = useEmailAuthAttempt({
    mode: accountSub === "login" ? "login" : "signup",
    email: accountEmail,
    password: accountPassword,
    // One form serves new and returning accounts.
    loginOnDuplicateEmail: true,
    onFocusField: (field) => {
      setAccountFieldIdx(field === "email" ? 0 : 1);
      setEditingField(true);
    },
    onSwitchToLogin: () => switchToAccountLogin(),
    onAttemptStart: () => setEditingField(false),
    onSignedIn: (_user, outcome) => {
      onboardingLog.info("Onboarding account step completed", { mode: outcome.mode });
      resetAccountPassword();
      setAccountOutcome(outcome);
      setAccountSub("signed-in");
      nextStep();
    },
    onFailed: (error, mode) => {
      onboardingLog.error("Onboarding account step failed", { mode, error: error.message });
    },
  });
  const { cancel, clearErrors, submitField } = auth;

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
    cancel();
    setAccountFieldIdx(0);
    setAccountSub(mode);
    setEditingField(true);
  }, [cancel, setEditingField]);

  const focusAccountField = useCallback((index: 0 | 1) => {
    clearErrors();
    setAccountFieldIdx(index);
    setEditingField(true);
  }, [clearErrors, setEditingField]);

  const beginQrSignIn = useCallback(() => {
    cancel();
    setAccountSub("qr");
    setEditingField(false);
  }, [cancel, setEditingField]);

  // The QR panel owns the network flow; this only records the outcome and
  // advances once the mobile app has approved the session.
  const completeQrSignIn = useCallback((email: string) => {
    cancel();
    resetAccountPassword();
    onboardingLog.info("Onboarding account step completed", { mode: "qr" });
    setAccountOutcome({ mode: "login", email });
    setAccountSub("signed-in");
    nextStep();
  }, [cancel, nextStep, resetAccountPassword]);

  /** Back to the email form from QR or the login fall-through, ready to type. */
  const returnToAccountForm = useCallback(() => {
    cancel();
    setAccountFieldIdx(0);
    setAccountSub("signup");
    setEditingField(true);
  }, [cancel, setEditingField]);

  const switchToAccountLogin = useCallback(() => {
    cancel();
    resetAccountPassword();
    setAccountFieldIdx(1);
    setAccountSub("login");
    setEditingField(true);
  }, [cancel, resetAccountPassword, setEditingField]);

  const submitAccountField = useCallback(() => {
    if (accountSub !== "signup" && accountSub !== "login") return;
    submitField(accountFieldIdx > 0 ? "password" : "email");
  }, [accountFieldIdx, accountSub, submitField]);

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
    accountSubmitting: auth.submitting,
    accountSubmitError: auth.submitError,
    accountValidationError: auth.validationError,
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
    syncExistingAccountSession,
  };
}
