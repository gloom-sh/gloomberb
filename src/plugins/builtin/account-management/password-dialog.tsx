import { useCallback, useState } from "react";
import { logFailure } from "../../../utils/log-failure";
import { Button, TextField } from "../../../components";
import { DialogFrame } from "../../../components/ui/frame";
import { Box } from "../../../ui";
import { useDialogKeyboard, type AlertContext } from "../../../ui/dialog";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import { t } from "../../../i18n";
import { MIN_ACCOUNT_PASSWORD_LENGTH } from "../../../account/auth-model";
import { ClippedText } from "../../../components/ui/display";

type PasswordDialogField = "current" | "new" | "confirm";

/**
 * Asks for the account's password to delete the account, when the session
 * signed in more than a day ago. `onDelete` throws to keep the dialog open
 * with its message, e.g. a wrong password.
 */
export function DeleteAccountPasswordDialog({
  dismiss,
  onDelete,
}: AlertContext & {
  onDelete: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!password) {
      setError(t("Enter your password."));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(password);
      dismiss();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : t("Failed to delete account."));
    } finally {
      setSubmitting(false);
    }
  }, [dismiss, onDelete, password, submitting]);

  // submit settles on its own; a failure it could not catch is logged.
  const submitPassword = () => {
    submit().catch(logFailure("account-management.delete-dialog", "Delete account submit failed"));
  };

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
    }
  }, { allowEditable: true });

  const fieldWidth = 42;
  return (
    <DialogFrame title={t("Delete Account")}>
      <Box flexDirection="column" gap={1}>
        <ClippedText text={t("Enter your password to delete your account.")} width={fieldWidth} cut={truncateWithEllipsis} wrap />
        <TextField
          label={t("Password")}
          active
          value={password}
          focused
          width={fieldWidth}
          type="password"
          onChange={setPassword}
          onSubmit={() => { submitPassword(); }}
        />
        {error ? <ClippedText fg={colors.negative} text={error} width={fieldWidth} cut={truncateWithEllipsis} wrap /> : null}
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            label={submitting ? t("Deleting...") : t("Delete Account")}
            variant="danger"
            disabled={submitting}
            onPress={() => { submitPassword(); }}
          />
        </Box>
      </Box>
    </DialogFrame>
  );
}

export function PasswordChangeDialog({
  dismiss,
  onChangePassword,
}: AlertContext & {
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const [activeField, setActiveField] = useState<PasswordDialogField>("current");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldOrder: PasswordDialogField[] = ["current", "new", "confirm"];

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!currentPassword || !newPassword) {
      setError(t("Current and new password are required."));
      return;
    }
    if (newPassword.length < MIN_ACCOUNT_PASSWORD_LENGTH) {
      setError(t("New password must be at least 8 characters."));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("New passwords do not match."));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onChangePassword(currentPassword, newPassword);
      dismiss();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : t("Failed to change password."));
    } finally {
      setSubmitting(false);
    }
  }, [confirmPassword, currentPassword, dismiss, newPassword, onChangePassword, submitting]);

  // The three fields are a ring: Tab past Confirm comes back to Current.
  const cycleDialogField = useCallback((delta: number) => {
    setActiveField((field) => {
      const index = fieldOrder.indexOf(field);
      return fieldOrder[(index + delta + fieldOrder.length) % fieldOrder.length] ?? "current";
    });
  }, []);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
      return;
    }
    const tab = event.name === "tab" && !event.ctrl && !event.meta && !event.alt;
    if (tab || (!event.targetEditable && isPlainKey(event, "down", "j", "up", "k"))) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleDialogField((tab ? event.shift : event.name === "up" || event.name === "k") ? -1 : 1);
    }
  }, { allowEditable: true });

  const fieldWidth = 42;
  return (
    <DialogFrame title={t("Change Password")}>
      <Box flexDirection="column" gap={1}>
        <TextField
          label={t("Current Password")}
          active={activeField === "current"}
          value={currentPassword}
          focused={activeField === "current"}
          width={fieldWidth}
          type="password"
          onMouseDown={() => setActiveField("current")}
          onChange={setCurrentPassword}
          onSubmit={() => setActiveField("new")}
        />
        <TextField
          label={t("New Password")}
          active={activeField === "new"}
          value={newPassword}
          focused={activeField === "new"}
          width={fieldWidth}
          type="password"
          onMouseDown={() => setActiveField("new")}
          onChange={setNewPassword}
          onSubmit={() => setActiveField("confirm")}
        />
        <TextField
          label={t("Confirm Password")}
          active={activeField === "confirm"}
          value={confirmPassword}
          focused={activeField === "confirm"}
          width={fieldWidth}
          type="password"
          onMouseDown={() => setActiveField("confirm")}
          onChange={setConfirmPassword}
          onSubmit={() => { void submit(); }}
        />
        {error ? <ClippedText fg={colors.negative} text={error} width={fieldWidth} cut={truncateWithEllipsis} wrap /> : null}
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            label={submitting ? t("Changing...") : t("Update Password")}
            variant="primary"
            disabled={submitting}
            onPress={() => { void submit(); }}
          />
        </Box>
      </Box>
    </DialogFrame>
  );
}
