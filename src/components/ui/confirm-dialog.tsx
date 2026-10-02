import { useCallback, type ReactNode } from "react";
import { Box, Text } from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { Button, type ButtonVariant } from "./button";
import { DialogFrame } from "./frame";

export interface ConfirmDialogProps extends PromptContext<boolean> {
  title: string;
  body: ReactNode | string | string[];
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  width?: number;
  /** The key-hint line under the buttons; an empty string leaves it out. */
  footer?: string;
  /** A line under the body: the work the confirm started, or why it failed. */
  status?: ReactNode;
  /** While the confirmed work runs: the buttons are off and only Esc answers. */
  busy?: boolean;
  /** Adds the desktop close button beside the title. */
  onClose?: () => void;
  /**
   * Lays the buttons out as a form's Cancel and Submit: Cancel, then the
   * action, at the right. By default the action comes first, at the left.
   */
  formButtons?: boolean;
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
  status,
  busy = false,
  onClose,
  formButtons = false,
}: ConfirmDialogProps) {
  const confirm = useCallback(() => resolve(true), [resolve]);
  const cancel = useCallback(() => resolve(false), [resolve]);

  // Every key, even with a field focused under the dialog: a confirm has
  // nothing to type into, so nothing below should take one.
  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (busy) {
      event.preventDefault();
      return;
    }
    if (event.name === "enter" || event.name === "return" || isPlainKey(event, "y")) {
      event.preventDefault();
      confirm();
      return;
    }
    if (isPlainKey(event, "n")) {
      event.preventDefault();
      cancel();
      return;
    }
    // Two buttons and nothing to type: Tab has nowhere to go.
    if (event.name === "tab") event.preventDefault();
  }, { allowEditable: true });

  const confirmButton = <Button label={confirmLabel} variant={confirmVariant} disabled={busy} onPress={confirm} />;
  const cancelButton = <Button label={cancelLabel} variant="secondary" disabled={busy} onPress={cancel} />;
  return (
    <DialogFrame
      title={title}
      footer={footer ?? tf("Enter {action} · Esc cancel", { action: t(confirmLabel).toLowerCase() })}
      onClose={onClose}
    >
      <Box flexDirection="column" width={width}>
        {renderBody(body)}
        {status && (
          <>
            <Box height={1} />
            {status}
          </>
        )}
        <Box height={1} />
        {formButtons ? (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            {cancelButton}
            {confirmButton}
          </Box>
        ) : (
          <Box flexDirection="row" gap={1}>
            {confirmButton}
            {cancelButton}
          </Box>
        )}
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
      <Text key={`${line}:${index}`} fg={index === 0 ? colors.text : colors.textDim} wrapText>{t(line)}</Text>
    ));
  }
  if (typeof body === "string") {
    return <Text fg={colors.text} wrapText>{body}</Text>;
  }
  return body;
}
