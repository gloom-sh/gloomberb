import type { RefObject } from "react";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { TextField } from "../../ui";
import type { AccountMode, AccountSubmitError } from "./model";

function FieldRow({
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
            onSubmit={() => {}}
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
}) {
  const onEmail = fieldIdx <= 0;

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {mode === "signup" ? t("Create your free account") : t("Log in to Gloom Cloud")}
        </Text>
      </Box>
      <Box height={1} />

      <FieldRow
        label={t("Email")}
        active={onEmail}
        value={email}
        masked={false}
        placeholder={"email@example.com"}
        editing={editing && !submitting}
        inputRef={inputRef}
        onChange={onEmailChange}
      />

      {!onEmail && (
        <>
          <Box height={1} />
          <FieldRow
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
      )}

      <Box height={1} />
      {/* Two rows so a long server error wraps instead of being clipped. */}
      <Box height={2}>
        {submitting ? (
          <Text fg={colors.text}>
            {mode === "signup" ? t("Creating your account...") : t("Signing you in...")}
          </Text>
        ) : validationError || submitError ? (
          <Text fg={colors.negative}>{validationError ?? submitError?.message ?? ""}</Text>
        ) : (
          <Text fg={colors.textDim}>
            {mode === "signup"
              ? t("We email a link to verify your address.")
              : t("Signs this terminal in to your account.")}
          </Text>
        )}
      </Box>
      <Box height={1}>
        {!submitting && submitError?.kind === "switch-to-login" && (
          <Text fg={colors.textDim}>{t("Press enter to log in with this email.")}</Text>
        )}
      </Box>

      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("esc to go back — this step is optional")}</Text>
      </Box>
    </Box>
  );
}
