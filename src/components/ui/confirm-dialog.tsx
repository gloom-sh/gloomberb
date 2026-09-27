import { useCallback, type ReactNode } from "react";
import { Box, Text } from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import { Button, type ButtonVariant } from "./button";
import { DialogFrame } from "./frame";

export interface ConfirmDialogProps extends PromptContext<boolean> {
  title: string;
  body: ReactNode | string | string[];
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  width?: number;
  footer?: string;
}

export function ConfirmDialog({
  resolve,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  width = 52,
  footer,
}: ConfirmDialogProps) {
  const confirm = useCallback(() => resolve(true), [resolve]);
  const cancel = useCallback(() => resolve(false), [resolve]);

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "enter" || event.name === "return") {
      confirm();
      return;
    }
    if (event.name === "escape") {
      cancel();
    }
  });

  return (
    <DialogFrame title={title} footer={footer ?? tf("Enter {action} · Esc cancel", { action: t(confirmLabel).toLowerCase() })}>
      <Box flexDirection="column" width={width}>
        {renderBody(body)}
        <Box height={1} />
        <Box flexDirection="row" gap={1}>
          <Button label={confirmLabel} variant={confirmVariant} onPress={confirm} />
          <Button label={cancelLabel} variant="secondary" onPress={cancel} />
        </Box>
      </Box>
    </DialogFrame>
  );
}

export type ConfirmDialogOptions = Omit<ConfirmDialogProps, keyof PromptContext<boolean>> & {
  /** A click on the backdrop cancels. On by default. */
  closeOnClickOutside?: boolean;
};

/**
 * Asks in a ConfirmDialog and resolves true only when the person confirms;
 * Cancel, Esc, a click outside or a failed dialog all resolve false.
 */
export async function confirmDialog(
  dialog: DialogApi,
  { closeOnClickOutside = true, ...props }: ConfirmDialogOptions,
): Promise<boolean> {
  const confirmed = await dialog.prompt<boolean>({
    closeOnClickOutside,
    content: (context) => <ConfirmDialog {...context} {...props} />,
  }).catch(() => false);
  return confirmed === true;
}

function renderBody(body: ReactNode | string | string[]): ReactNode {
  if (Array.isArray(body)) {
    return body.map((line, index) => (
      <Text key={`${line}:${index}`} fg={index === 0 ? colors.text : colors.textDim}>{t(line)}</Text>
    ));
  }
  if (typeof body === "string") {
    return <Text fg={colors.text}>{body}</Text>;
  }
  return body;
}
