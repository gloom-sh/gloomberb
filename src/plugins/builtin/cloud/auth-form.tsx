/**
 * Email/password auth form body, without any surrounding chrome. The dialog
 * wraps it in a `DialogFrame`; the hosted-terminal sign-in gate wraps it in its
 * own panel. The sign-in attempt it shares with onboarding lives in
 * `email-auth-attempt`, the non-React logic in `auth-model`.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import { matchesKeyChord, parseKeyChord } from "../../../app/keybindings";
import { Button, Spinner, TextField } from "../../../components";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { useDialogKeyboard } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import { validateAccountEmail, type AccountMode } from "./auth-model";
import { useEmailAuthAttempt, type EmailAuthField } from "./email-auth-attempt";

export const AUTH_FIELD_WIDTH = 42;

type ResetState = "idle" | "sending" | "sent";

/**
 * The form's secondary actions. A field always has the keyboard here, so each
 * takes a Control chord that no field uses for editing, shown on its button.
 * Control on every host, like the other in-form chords (Ctrl+S save).
 */
const SWITCH_MODE_KEY = "Ctrl+L";
const RESET_PASSWORD_KEY = "Ctrl+R";
const REVEAL_PASSWORD_KEY = "Ctrl+O";
const SWITCH_MODE_CHORD = parseKeyChord(SWITCH_MODE_KEY)!;
const RESET_PASSWORD_CHORD = parseKeyChord(RESET_PASSWORD_KEY)!;
const REVEAL_PASSWORD_CHORD = parseKeyChord(REVEAL_PASSWORD_KEY)!;

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
  const [activeField, setActiveField] = useState<EmailAuthField>("email");
  const [showPassword, setShowPassword] = useState(false);
  const [resetState, setResetState] = useState<ResetState>("idle");
  const emailInputRef = useRef<InputRenderable>(null);
  const passwordInputRef = useRef<InputRenderable>(null);
  const {
    submitting,
    validationError,
    submitError,
    setValidationError,
    setSubmitError,
    clearErrors,
    cancel,
    submit,
    submitField,
  } = useEmailAuthAttempt({
    mode,
    email,
    password,
    onFocusField: setActiveField,
    onSwitchToLogin: () => switchMode("login"),
    onSignedIn,
  });

  /**
   * Moves the keyboard to a field. Focusing directly as well as through the
   * `focused` prop brings it back when a clicked button holds the focus and
   * the field is already the active one.
   */
  const focusField = useCallback((field: EmailAuthField) => {
    setActiveField(field);
    if (!submitting) (field === "email" ? emailInputRef : passwordInputRef).current?.focus?.();
  }, [submitting]);

  const switchMode = useCallback((nextMode: AccountMode) => {
    cancel();
    setMode(nextMode);
    setPassword("");
    setResetState("idle");
    setActiveField(email.trim() ? "password" : "email");
    onModeChange?.(nextMode);
  }, [cancel, email, onModeChange]);

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
  }, [clearErrors, email, resetState, setSubmitError, setValidationError, submitting]);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      if (!onEscape) return;
      event.stopPropagation?.();
      onEscape();
      return;
    }
    const consume = () => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    if (matchesKeyChord(SWITCH_MODE_CHORD, event)) {
      consume();
      if (!submitting) switchMode(mode === "login" ? "signup" : "login");
      return;
    }
    if (matchesKeyChord(RESET_PASSWORD_CHORD, event) && mode === "login") {
      consume();
      requestReset();
      return;
    }
    if (matchesKeyChord(REVEAL_PASSWORD_CHORD, event)) {
      consume();
      setShowPassword((current) => !current);
      return;
    }
    const shiftTab = event.name === "tab" && event.shift && !event.ctrl && !event.alt && !event.meta && !event.super;
    const forward = isPlainKey(event, "tab") || (!event.targetEditable && isPlainKey(event, "down", "j"));
    const backward = shiftTab || (!event.targetEditable && isPlainKey(event, "up", "k"));
    if (forward || backward) {
      consume();
      focusField(forward ? "password" : "email");
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
        inputRef={emailInputRef}
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
        onSubmit={() => submitField(activeField)}
      />
      <Box flexDirection="column">
        <Box height={1} width={AUTH_FIELD_WIDTH} flexDirection="row" justifyContent="space-between">
          <Text
            fg={activeField === "password" ? colors.textBright : colors.textDim}
            attributes={activeField === "password" ? TextAttributes.BOLD : 0}
          >
            {t("Password")}
          </Text>
          <Button
            stopPropagation
            label={showPassword ? t("Hide password") : t("Show password")}
            displayLabel={showPassword ? t("hide") : t("show")}
            variant="plain"
            compact
            shortcut={REVEAL_PASSWORD_KEY}
            onPress={() => setShowPassword((current) => !current)}
          />
        </Box>
        <TextField
          inputRef={passwordInputRef}
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
          onSubmit={() => submitField(activeField)}
        />
      </Box>
      <Box flexDirection="column" minHeight={2} width={AUTH_FIELD_WIDTH}>
        {submitting ? (
          <Spinner label={mode === "signup" ? t("Creating your account...") : t("Signing you in...")} />
        ) : resetState === "sending" ? (
          <Spinner label={t("Sending reset link...")} />
        ) : error ? (
          <>
            <Text fg={colors.negative} wrapText>{error}</Text>
            {switchToLogin ? <Text fg={colors.textMuted} wrapText>{t("Press enter to log in with this email.")}</Text> : null}
          </>
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
          shortcut={SWITCH_MODE_KEY}
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
            variant="plain"
            disabled={submitting || resetState === "sending"}
            shortcut={RESET_PASSWORD_KEY}
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
