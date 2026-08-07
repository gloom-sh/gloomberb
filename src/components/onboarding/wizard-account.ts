import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiClient } from "../../api-client";
import { chatController } from "../../plugins/builtin/chat/controller";
import { debugLog } from "../../utils/debug-log";
import {
  advanceAccountField,
  classifyAccountError,
  deriveUsernameFromEmail,
  isUsernameConflictError,
  validateAccountEmail,
  validateAccountPassword,
  type AccountMode,
  type AccountOutcome,
  type AccountSub,
  type AccountSubmitError,
} from "./account-step/model";

const onboardingLog = debugLog.createLogger("onboarding");

export interface OnboardingAccountState {
  accountSub: AccountSub;
  accountChoiceIdx: number;
  accountEmail: string;
  accountPassword: string;
  accountFieldIdx: number;
  accountSubmitting: boolean;
  accountSubmitError: AccountSubmitError | null;
  accountValidationError: string | null;
  accountOutcome: AccountOutcome | null;
  setAccountChoiceIdx: Dispatch<SetStateAction<number>>;
  setAccountEmail: (value: string) => void;
  setAccountPassword: (value: string) => void;
  beginAccountMode: (mode: AccountMode) => void;
  returnToAccountChooser: () => void;
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
  const [accountSub, setAccountSub] = useState<AccountSub>("choose");
  const [accountChoiceIdx, setAccountChoiceIdx] = useState(0);
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

  const returnToAccountChooser = useCallback(() => {
    attemptRef.current += 1;
    clearErrors();
    setAccountSubmitting(false);
    setAccountFieldIdx(0);
    setAccountSub("choose");
    setEditingField(false);
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
      try {
        if (mode === "signup") {
          try {
            const username = deriveUsernameFromEmail(email);
            await apiClient.signUp(email, username, username, password);
          } catch (error) {
            if (!isUsernameConflictError(error)) throw error;
            const retryUsername = deriveUsernameFromEmail(email, 1);
            await apiClient.signUp(email, retryUsername, retryUsername, password);
          }
          await apiClient.sendVerification().catch(() => {});
        } else {
          await apiClient.signIn(email, password);
        }

        // Hands the freshly captured session cookie to the chat controller so it
        // reaches plugin persistence instead of living only in this process.
        chatController.clearSession();
        await chatController.refreshSession().catch(() => {});

        if (attemptRef.current !== attemptId) return;
        onboardingLog.info("Onboarding account step completed", { mode });
        setAccountSubmitting(false);
        resetAccountPassword();
        setAccountOutcome({ mode, email });
        setAccountSub("signed-in");
        nextStep();
      } catch (error) {
        if (attemptRef.current !== attemptId) return;
        const submitError = classifyAccountError(error, mode);
        onboardingLog.error("Onboarding account step failed", { mode, error: submitError.message });
        setAccountSubmitting(false);
        setAccountSubmitError(submitError);
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
    if (accountOutcome || accountSub !== "choose" || !apiClient.getSessionToken()) return;
    const user = apiClient.getCurrentUser();
    setAccountOutcome({ mode: "login", email: user?.email?.trim() || user?.username?.trim() || "" });
    setAccountSub("signed-in");
  }, [accountOutcome, accountSub]);

  return {
    accountSub,
    accountChoiceIdx,
    accountEmail,
    accountPassword,
    accountFieldIdx,
    accountSubmitting,
    accountSubmitError,
    accountValidationError,
    accountOutcome,
    setAccountChoiceIdx,
    setAccountEmail,
    setAccountPassword,
    beginAccountMode,
    returnToAccountChooser,
    switchToAccountLogin,
    submitAccountField,
    submitAccount,
    syncExistingAccountSession,
  };
}
