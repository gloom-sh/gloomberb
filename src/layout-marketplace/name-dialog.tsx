import { useCallback, useState } from "react";
import { Box } from "../ui";
import { Button } from "../components/ui/button";
import { DialogFrame } from "../components/ui/frame";
import { TextField } from "../components/ui/fields";
import { t } from "../i18n";
import { useDialogKeyboard, type PromptContext } from "../ui/dialog";

const FIELD_WIDTH = 40;

export function LayoutNameDialog({
  resolve,
  dismiss,
  title,
  label,
  confirmLabel,
  initialValue,
}: PromptContext<string | undefined> & {
  title: string;
  label: string;
  confirmLabel: string;
  initialValue: string;
}) {
  const [value, setValue] = useState(initialValue);
  const submit = useCallback((next: string) => {
    const trimmed = next.trim();
    if (trimmed) resolve(trimmed);
  }, [resolve]);

  useDialogKeyboard((event) => {
    if (event.name !== "escape") return;
    event.stopPropagation?.();
    dismiss();
  }, { allowEditable: true });

  return (
    <DialogFrame title={title}>
      <Box flexDirection="column" width={FIELD_WIDTH + 4} gap={1}>
        <TextField
          label={t(label)}
          value={value}
          placeholder={t("e.g. Trading, Research, Overview")}
          focused
          width={FIELD_WIDTH}
          onChange={setValue}
          onSubmit={submit}
        />
        <Box flexDirection="row" gap={1}>
          <Button
            label={confirmLabel}
            variant="primary"
            disabled={value.trim().length === 0}
            onPress={() => submit(value)}
          />
          <Button label="Cancel" variant="secondary" onPress={dismiss} />
        </Box>
      </Box>
    </DialogFrame>
  );
}
