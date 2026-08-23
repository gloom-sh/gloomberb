/**
 * Shared email/password auth dialog plus the request bridge that lets commands
 * (which run outside the React tree) open it. `AuthDialogHost` is mounted by
 * the shell for the life of the app and owns the actual dialog, mirroring the
 * QR sign-in dialog host.
 */
import { useCallback, useState } from "react";
import type { AuthUser } from "../../../api-client";
import { Button, Spinner, TextField } from "../../../components";
import { DialogFrame } from "../../../components/ui/frame";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import { useDialog, useDialogKeyboard, type PromptContext } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import { useEffect, useRef } from "react";
import {
  advanceAccountField,
  classifyAccountError,
  performEmailAuth,
  validateAccountEmail,
  validateAccountPassword,
  type AccountMode,
  type AccountSubmitError,
} from "./auth-model";

const FIELD_WIDTH = 42;

type AuthField = "email" | "password";

export function AuthDialog({
  initialMode,
  resolve,
  dismiss,
}: PromptContext<AuthUser | undefined> & { initialMode: AccountMode }) {
  useAppLanguage();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [activeField, setActiveField] = useState<AuthField>("email");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<AccountSubmitError | null>(null);
  const attemptRef = useRef(0);

  const clearErrors = useCallback(() => {
    setValidationError(null);
    setSubmitError(null);
  }, []);

  useEffect(() => () => {
    // Unmounting abandons any in-flight attempt so a late response can't set state.
    attemptRef.current += 1;
  }, []);

  const switchMode = useCallback((nextMode: AccountMode) => {
    attemptRef.current += 1;
    setMode(nextMode);
    setSubmitting(false);
    setPassword("");
    clearErrors();
    setActiveField(email.trim() ? "password" : "email");
  }, [clearErrors, email]);

  const submit = useCallback(() => {
    if (submitting) return;
    const trimmedEmail = email.trim();
    const emailError = validateAccountEmail(trimmedEmail);
    if (emailError) {
      setActiveField("email");
      setValidationError(emailError);
      return;
    }
    const passwordError = validateAccountPassword(password, mode);
    if (passwordError) {
      setActiveField("password");
      setValidationError(passwordError);
      return;
    }

    const attemptId = attemptRef.current + 1;
    attemptRef.current = attemptId;
    setSubmitting(true);
    clearErrors();
    void (async () => {
      try {
        const user = await performEmailAuth(mode, trimmedEmail, password);
        if (attemptRef.current !== attemptId) return;
        resolve(user);
      } catch (error) {
        if (attemptRef.current !== attemptId) return;
        setSubmitting(false);
        setSubmitError(classifyAccountError(error, mode));
      }
    })();
  }, [clearErrors, email, mode, password, resolve, submitting]);

  const submitField = useCallback(() => {
    const advance = advanceAccountField({
      mode,
      email: email.trim(),
      password,
      fieldIdx: activeField === "email" ? 0 : 1,
    });
    if (advance.action === "invalid") {
      setValidationError(advance.message);
      return;
    }
    if (advance.action === "next-field") {
      setValidationError(null);
      setActiveField("password");
      return;
    }
    submit();
  }, [activeField, email, mode, password, submit]);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
      return;
    }
    const forward = isPlainKey(event, "tab") || (!event.targetEditable && isPlainKey(event, "down", "j"));
    const backward = !event.targetEditable && isPlainKey(event, "up", "k");
    if (forward || backward) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveField(forward ? "password" : "email");
    }
  }, { allowEditable: true });

  const switchToLogin = submitError?.kind === "switch-to-login";
  const error = validationError ?? submitError?.message ?? null;

  return (
    <DialogFrame title={mode === "login" ? t("Log in to Gloomberb") : t("Create your Gloomberb account")}>
      <Box flexDirection="column" gap={1}>
        <TextField
          label={t("Email")}
          value={email}
          placeholder="email@example.com"
          focused={activeField === "email" && !submitting}
          width={FIELD_WIDTH}
          type="email"
          autoComplete="email"
          onMouseDown={() => setActiveField("email")}
          onChange={(value) => {
            setEmail(value);
            clearErrors();
          }}
          onSubmit={submitField}
        />
        <Box flexDirection="column">
          <Box height={1} width={FIELD_WIDTH} flexDirection="row" justifyContent="space-between">
            <Text
              fg={activeField === "password" ? colors.textBright : colors.textDim}
              attributes={activeField === "password" ? TextAttributes.BOLD : 0}
            >
              {t("Password")}
            </Text>
            <Box onMouseDown={() => setShowPassword((current) => !current)}>
              <Text fg={colors.textMuted}>{showPassword ? t("hide") : t("show")}</Text>
            </Box>
          </Box>
          <TextField
            value={password}
            placeholder={mode === "signup" ? t("At least 8 characters") : t("Your password")}
            focused={activeField === "password" && !submitting}
            width={FIELD_WIDTH}
            type={showPassword ? "text" : "password"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            onMouseDown={() => setActiveField("password")}
            onChange={(value) => {
              setPassword(value);
              clearErrors();
            }}
            onSubmit={submitField}
          />
        </Box>
        <Box flexDirection="column" minHeight={2} width={FIELD_WIDTH}>
          {submitting ? (
            <Spinner label={mode === "signup" ? t("Creating your account...") : t("Signing you in...")} />
          ) : error ? (
            <Text fg={colors.negative} wrapText>{error}</Text>
          ) : mode === "signup" ? (
            <Text fg={colors.textMuted} wrapText>{t("We'll email you a verification link.")}</Text>
          ) : null}
        </Box>
        <Box flexDirection="row" justifyContent="space-between" width={FIELD_WIDTH}>
          <Button
            label={mode === "login" ? t("Log In") : t("Create Account")}
            variant="primary"
            disabled={submitting}
            onPress={submit}
          />
          <Button
            label={switchToLogin || mode === "signup" ? t("Log in instead") : t("Sign up instead")}
            variant="ghost"
            disabled={submitting}
            onPress={() => switchMode(mode === "login" ? "signup" : "login")}
          />
        </Box>
      </Box>
    </DialogFrame>
  );
}

export interface AuthDialogRequest {
  mode?: AccountMode;
  onSignedIn?: (user: AuthUser) => void;
}

const authDialogListeners = new Set<(request: AuthDialogRequest) => void>();

/** Returns false when no dialog host is mounted, so callers can fall back. */
export function requestAuthDialog(request: AuthDialogRequest = {}): boolean {
  if (authDialogListeners.size === 0) return false;
  for (const listener of authDialogListeners) listener(request);
  return true;
}

export function AuthDialogHost() {
  const dialog = useDialog();
  const openRef = useRef(false);

  useEffect(() => {
    const listener = (request: AuthDialogRequest) => {
      if (openRef.current) return;
      openRef.current = true;
      void dialog
        .prompt<AuthUser | undefined>({
          closeOnClickOutside: false,
          content: (context: unknown) => (
            <AuthDialog
              {...(context as PromptContext<AuthUser | undefined>)}
              initialMode={request.mode ?? "login"}
            />
          ),
        })
        .then((user) => {
          if (user) request.onSignedIn?.(user);
        })
        .finally(() => {
          openRef.current = false;
        });
    };
    authDialogListeners.add(listener);
    return () => {
      authDialogListeners.delete(listener);
    };
  }, [dialog]);

  return null;
}
