import type { RefObject } from "react";
import { Box, Text, TextAttributes, useUiHost, type InputRenderable } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { TextField } from "../../ui";
import type { AccountMode, AccountSubmitError } from "../../../plugins/builtin/cloud/auth-model";
import { ONBOARDING_DESKTOP } from "../onboarding-frame";

function TuiFieldRow({
  label,
  active,
  value,
  masked,
  placeholder,
  editing,
  inputRef,
  onChange,
}: {
  label: string;
  active: boolean;
  value: string;
  masked: boolean;
  placeholder: string;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
  onChange: (value: string) => void;
}) {
  if (!active) {
    return (
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive}>{"✓ "}</Text>
        <Text fg={colors.text}>{`${label}: ${masked ? "*".repeat(value.length) : value}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text fg={colors.text} attributes={TextAttributes.BOLD}>{label}</Text>
      </Box>
      <Box height={1}>
        {editing ? (
          <TextField
            inputRef={inputRef}
            value={value}
            type={masked ? "password" : "text"}
            placeholder={placeholder}
            focused
            backgroundColor={colors.panel}
            textColor={colors.text}
            placeholderColor={colors.textDim}
            onChange={onChange}
          />
        ) : (
          <Text fg={value ? colors.text : colors.textMuted}>
            {value ? (masked ? "*".repeat(value.length) : value) : t("Press enter to type...")}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function AccountFormPanel({
  mode,
  email,
  password,
  fieldIdx,
  editing,
  inputRef,
  submitting,
  submitError,
  validationError,
  onEmailChange,
  onPasswordChange,
  onFieldFocus,
}: {
  mode: AccountMode;
  email: string;
  password: string;
  fieldIdx: number;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
  submitting: boolean;
  submitError: AccountSubmitError | null;
  validationError: string | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onFieldFocus: (index: 0 | 1) => void;
}) {
  const desktop = useUiHost().kind === "desktop-web";
  const onEmail = fieldIdx <= 0;

  if (desktop) {
    const status = submitting
      ? { color: colors.text, text: mode === "signup" ? t("Creating your account...") : t("Signing you in...") }
      : validationError || submitError
        ? { color: colors.negative, text: validationError ?? submitError?.message ?? "" }
        : null;
    return (
      <Box flexDirection="column" style={{ marginTop: ONBOARDING_DESKTOP.afterHeader, gap: 14 }}>
        <TextField
          label={t("Email")}
          inputRef={onEmail ? inputRef : undefined}
          value={email}
          type="email"
          autoComplete="email"
          size="comfortable"
          placeholder="email@example.com"
          focused={onEmail && editing && !submitting}
          backgroundColor={colors.panel}
          textColor={colors.text}
          placeholderColor={colors.textDim}
          onMouseDown={() => onFieldFocus(0)}
          onChange={onEmailChange}
        />
        <TextField
          label={t("Password")}
          inputRef={!onEmail ? inputRef : undefined}
          value={password}
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          size="comfortable"
          placeholder={mode === "signup" ? t("At least 8 characters") : t("Your password")}
          focused={!onEmail && editing && !submitting}
          backgroundColor={colors.panel}
          textColor={colors.text}
          placeholderColor={colors.textDim}
          onMouseDown={() => onFieldFocus(1)}
          onChange={onPasswordChange}
        />
        {/* Reserved so the footer does not jump when a message appears. */}
        <Box style={{ minHeight: 18 }}>
          {status ? <Text fg={status.color} wrapText>{status.text}</Text> : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <TuiFieldRow
        label={t("Email")}
        active={onEmail}
        value={email}
        masked={false}
        placeholder="email@example.com"
        editing={editing}
        inputRef={inputRef}
        onChange={onEmailChange}
      />

      {!onEmail ? (
        <>
          <Box height={1} />
          <TuiFieldRow
            label={t("Password")}
            active
            value={password}
            masked
            placeholder={mode === "signup" ? t("Min 8 characters") : t("Your password")}
            editing={editing && !submitting}
            inputRef={inputRef}
            onChange={onPasswordChange}
          />
        </>
      ) : null}

      <Box height={1} />
      <Box
        height={submitting || validationError || submitError ? 2 : 1}
        overflow="hidden"
      >
        {submitting ? (
          <Text fg={colors.text} wrapText>
            {mode === "signup" ? t("Creating your account...") : t("Signing you in...")}
          </Text>
        ) : validationError || submitError ? (
          <Text fg={colors.negative} wrapText>{validationError ?? submitError?.message ?? ""}</Text>
        ) : (
          <Text fg={colors.textDim}>
            {mode === "signup"
              ? t("New accounts get a verification email.")
              : t("Signs this terminal in to your account.")}
          </Text>
        )}
      </Box>
      {!submitting && submitError?.kind === "switch-to-login" ? (
        <Box height={1} overflow="hidden">
          <Text fg={colors.textDim}>{t("Press enter to log in with this email.")}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
