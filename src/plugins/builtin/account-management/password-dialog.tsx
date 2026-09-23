import { useCallback, useState } from "react";
import { Button, TextField } from "../../../components";
import { DialogFrame } from "../../../components/ui/frame";
import { Box, Text } from "../../../ui";
import { useDialogKeyboard, type AlertContext } from "../../../ui/dialog";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { t } from "../../../i18n";
import { truncate } from "./model";
import { useFieldLabel } from "./form-components";

type PasswordDialogField = "current" | "new" | "confirm";

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
    if (newPassword.length < 8) {
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

  const cycleDialogField = useCallback((delta: number) => {
    setActiveField((field) => {
      const index = fieldOrder.indexOf(field);
      return fieldOrder[Math.max(0, Math.min(fieldOrder.length - 1, index + delta))] ?? "current";
    });
  }, []);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
      return;
    }
    if (isPlainKey(event, "tab") || (!event.targetEditable && isPlainKey(event, "down", "j"))) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleDialogField(1);
      return;
    }
    if (!event.targetEditable && isPlainKey(event, "up", "k")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleDialogField(-1);
    }
  }, { allowEditable: true });

  const fieldWidth = 42;
  const fieldLabel = useFieldLabel();
  return (
    <DialogFrame title={t("Change Password")}>
      <Box flexDirection="column" gap={1}>
        <TextField
          label={fieldLabel(t("Current Password"), activeField === "current")}
          value={currentPassword}
          focused={activeField === "current"}
          width={fieldWidth}
          type="password"
          onMouseDown={() => setActiveField("current")}
          onChange={setCurrentPassword}
          onSubmit={() => { void submit(); }}
        />
        <TextField
          label={fieldLabel(t("New Password"), activeField === "new")}
          value={newPassword}
          focused={activeField === "new"}
          width={fieldWidth}
          type="password"
          onMouseDown={() => setActiveField("new")}
          onChange={setNewPassword}
          onSubmit={() => { void submit(); }}
        />
        <TextField
          label={fieldLabel(t("Confirm Password"), activeField === "confirm")}
          value={confirmPassword}
          focused={activeField === "confirm"}
          width={fieldWidth}
          type="password"
          onMouseDown={() => setActiveField("confirm")}
          onChange={setConfirmPassword}
          onSubmit={() => { void submit(); }}
        />
        {error ? <Text fg={colors.negative}>{truncate(error, fieldWidth)}</Text> : null}
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
