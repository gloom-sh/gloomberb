/**
 * Email/password auth form body, without any surrounding chrome. The dialog
 * wraps it in a `DialogFrame`; the hosted-terminal sign-in gate wraps it in its
 * own panel. All the non-React logic lives in `auth-model`.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import { Button, Spinner, TextField } from "../../../components";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import { useDialogKeyboard } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import {
  advanceAccountField,
  classifyAccountError,
  performEmailAuth,
  validateAccountEmail,
  validateAccountPassword,
  type AccountMode,
  type AccountSubmitError,
} from "./auth-model";

export const AUTH_FIELD_WIDTH = 42;

type AuthField = "email" | "password";

type ResetState = "idle" | "sending" | "sent";

export interface AuthFormProps {
  initialMode: AccountMode;
  /** Called once the session exists. */
  onSignedIn: (user: AuthUser) => void;
  /** Omitted where the form cannot be abandoned, e.g. the sign-in gate. */
  onEscape?: () => void;
  /**
   * Groups this form's keys with the surface that owns it. Left unset inside a
   * dialog, where `useDialogKeyboard` falls back to the dialog's own scope.
   */
  shortcutScope?: string;
  /** Fires when the user flips between sign-up and log in, so the host can retitle. */
  onModeChange?: (mode: AccountMode) => void;
  /** Extra actions below the buttons, e.g. the gate's QR alternative. */
  footer?: ReactNode;
}

export function AuthForm({
  initialMode,
  onSignedIn,
  onEscape,
  shortcutScope,
  onModeChange,
  footer,
}: AuthFormProps) {
  useAppLanguage();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [activeField, setActiveField] = useState<AuthField>("email");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<AccountSubmitError | null>(null);
  const [resetState, setResetState] = useState<ResetState>("idle");
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
    setResetState("idle");
    clearErrors();
    setActiveField(email.trim() ? "password" : "email");
    onModeChange?.(nextMode);
  }, [clearErrors, email, onModeChange]);

  const requestReset = useCallback(() => {
    if (submitting || resetState === "sending") return;
    const trimmedEmail = email.trim();
    const emailError = validateAccountEmail(trimmedEmail);
    if (emailError) {
      setActiveField("email");
      setValidationError(emailError);
      return;
    }
    setResetState("sending");
    clearErrors();
    void apiClient.requestPasswordReset(trimmedEmail)
      .then(() => setResetState("sent"))
      .catch(() => {
        setResetState("idle");
        setSubmitError({ message: t("Could not send the reset email."), kind: "retry" });
      });
  }, [clearErrors, email, resetState, submitting]);

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
        onSignedIn(user);
      } catch (error) {
        if (attemptRef.current !== attemptId) return;
        setSubmitting(false);
        setSubmitError(classifyAccountError(error, mode));
      }
    })();
  }, [clearErrors, email, mode, onSignedIn, password, submitting]);

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
      if (!onEscape) return;
      event.stopPropagation?.();
      onEscape();
      return;
    }
    const forward = isPlainKey(event, "tab") || (!event.targetEditable && isPlainKey(event, "down", "j"));
    const backward = !event.targetEditable && isPlainKey(event, "up", "k");
    if (forward || backward) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveField(forward ? "password" : "email");
    }
  }, {
    allowEditable: true,
    scope: shortcutScope,
    phase: shortcutScope ? "before" : undefined,
  });

  const switchToLogin = submitError?.kind === "switch-to-login";
  const error = validationError ?? submitError?.message ?? null;

  return (
    <Box flexDirection="column" gap={1}>
      <TextField
        label={t("Email")}
        value={email}
        placeholder="email@example.com"
        focused={activeField === "email" && !submitting}
        width={AUTH_FIELD_WIDTH}
        type="email"
        autoComplete="email"
        onMouseDown={() => setActiveField("email")}
        onChange={(value) => {
          setEmail(value);
          setResetState("idle");
          clearErrors();
        }}
        onSubmit={submitField}
      />
      <Box flexDirection="column">
        <Box height={1} width={AUTH_FIELD_WIDTH} flexDirection="row" justifyContent="space-between">
          <Text
            fg={activeField === "password" ? colors.textBright : colors.textDim}
            attributes={activeField === "password" ? TextAttributes.BOLD : 0}
          >
            {t("Password")}
          </Text>
          <Button stopPropagation label={showPassword ? t("Hide password") : t("Show password")} displayLabel={showPassword ? t("hide") : t("show")} variant="ghost" compact onPress={() => setShowPassword((current) => !current)} />
        </Box>
        <TextField
          value={password}
          placeholder={mode === "signup" ? t("At least 8 characters") : t("Your password")}
          focused={activeField === "password" && !submitting}
          width={AUTH_FIELD_WIDTH}
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
      <Box flexDirection="column" minHeight={2} width={AUTH_FIELD_WIDTH}>
        {submitting ? (
          <Spinner label={mode === "signup" ? t("Creating your account...") : t("Signing you in...")} />
        ) : resetState === "sending" ? (
          <Spinner label={t("Sending reset link...")} />
        ) : error ? (
          <Text fg={colors.negative} wrapText>{error}</Text>
        ) : resetState === "sent" ? (
          <Text fg={colors.positive} wrapText>
            {tf("Reset link sent to {email}. Check your inbox.", { email: email.trim() })}
          </Text>
        ) : mode === "signup" ? (
          <Text fg={colors.textMuted} wrapText>{t("We'll email you a verification link.")}</Text>
        ) : null}
      </Box>
      <Box flexDirection="row" justifyContent="space-between" width={AUTH_FIELD_WIDTH}>
        <Button stopPropagation
          label={switchToLogin || mode === "signup" ? t("Log in instead") : t("Sign up instead")}
          variant="ghost"
          disabled={submitting}
          onPress={() => switchMode(mode === "login" ? "signup" : "login")}
        />
        <Button stopPropagation
          label={mode === "login" ? t("Log In") : t("Create Account")}
          variant="primary"
          disabled={submitting}
          onPress={submit}
        />
      </Box>
      {mode === "login" && (
        <Box flexDirection="row" width={AUTH_FIELD_WIDTH}>
          <Button stopPropagation
            label={t("Forgot password?")}
            variant="ghost"
            disabled={submitting || resetState === "sending"}
            onPress={requestReset}
          />
        </Box>
      )}
      {footer}
    </Box>
  );
}

/** Title for the surface hosting the form, so the dialog and gate agree. */
export function authFormTitle(mode: AccountMode): string {
  return mode === "login"
    ? t("Log in to Gloom Cloud")
    : t("Create your free Gloom Cloud account");
}
