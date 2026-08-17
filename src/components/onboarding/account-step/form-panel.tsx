import type { RefObject } from "react";
import { Box, Text, TextAttributes, useUiHost, type InputRenderable } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { TextField } from "../../ui";
import type { AccountMode, AccountSubmitError } from "./model";

function TuiFieldRow({
  label,
  active,
  value,
  masked,
  placeholder,
  editing,
  inputRef,
  onChange,
  onSubmit,
}: {
  label: string;
  active: boolean;
  value: string;
  masked: boolean;
  placeholder: string;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
  onChange: (value: string) => void;
  onSubmit?: () => void;
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
            onSubmit={() => onSubmit?.()}
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
  onSubmitField,
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
  onSubmitField?: () => void;
}) {
  const desktop = useUiHost().kind === "desktop-web";
  const onEmail = fieldIdx <= 0;

  if (desktop) {
    return (
      <Box flexDirection="column" style={{ marginTop: 14, gap: 10 }}>
        <TextField
          label={t("Email")}
          inputRef={onEmail ? inputRef : undefined}
          value={email}
          type="text"
          placeholder="email@example.com"
          focused={onEmail && editing && !submitting}
          backgroundColor={colors.panel}
          textColor={colors.text}
          placeholderColor={colors.textDim}
          onMouseDown={() => onFieldFocus(0)}
          onChange={onEmailChange}
          onSubmit={() => onSubmitField?.()}
        />
        <TextField
          label={t("Password")}
          inputRef={!onEmail ? inputRef : undefined}
          value={password}
          type="password"
          placeholder={mode === "signup" ? t("At least 8 characters") : t("Your password")}
          focused={!onEmail && editing && !submitting}
          backgroundColor={colors.panel}
          textColor={colors.text}
          placeholderColor={colors.textDim}
          onMouseDown={() => onFieldFocus(1)}
          onChange={onPasswordChange}
          onSubmit={() => onSubmitField?.()}
        />
        <Box minHeight="40px" style={{ paddingTop: 2 }}>
          {submitting ? (
            <Text fg={colors.text} wrapText>
              {mode === "signup" ? t("Creating your account...") : t("Signing you in...")}
            </Text>
          ) : validationError || submitError ? (
            <Text fg={colors.negative} wrapText>
              {validationError ?? submitError?.message ?? ""}
            </Text>
          ) : (
            <Text fg={colors.textMuted} wrapText>
              {mode === "signup"
                ? t("We will email you a verification link. Cloud features unlock after verification.")
                : t("This signs the app in to your Gloom Cloud account.")}
            </Text>
          )}
          {!submitting && submitError?.kind === "switch-to-login" ? (
            <Text fg={colors.textDim} wrapText style={{ marginTop: 3 }}>
              {t("Use Log in with this email instead.")}
            </Text>
          ) : null}
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
        onSubmit={onSubmitField}
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
            onSubmit={onSubmitField}
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
              ? t("We email a link to verify your address.")
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
