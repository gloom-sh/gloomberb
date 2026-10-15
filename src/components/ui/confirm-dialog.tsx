import { useCallback, useRef, type ReactNode } from "react";
import { Box, Text, useUiHost } from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { Button, type ButtonVariant } from "./button";
import { DialogActions } from "./dialog-actions";
import { DialogFrame, fitDialogWidth } from "./frame";

export interface ConfirmDialogProps extends PromptContext<boolean> {
  title: string;
  body: ReactNode | string | string[];
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  width?: number;
  /**
   * The terminal's key-hint line under the buttons; an empty string leaves it
   * out, and the keys off the desktop buttons too.
   */
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
  /**
   * How long after opening Enter and `y` do not confirm, for a confirm that
   * opens on its own while the person may be typing. Esc and `n` always answer.
   */
  keyGraceMs?: number;
  /**
   * What Enter answers. `cancel` is for an opt-in a stray Enter must not
   * accept: Enter takes the cancel button, which is drawn as the primary one,
   * and only `y` or the confirm button confirms.
   */
  defaultAction?: "confirm" | "cancel";
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
  keyGraceMs = 0,
  defaultAction = "confirm",
}: ConfirmDialogProps) {
  const enterCancels = defaultAction === "cancel";
  const desktop = useUiHost().kind === "desktop-web";
  const openedAt = useRef(Date.now());
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
    const enter = event.name === "enter" || event.name === "return";
    if (enter && enterCancels) {
      event.preventDefault();
      cancel();
      return;
    }
    if (enter || isPlainKey(event, "y")) {
      event.preventDefault();
      if (Date.now() - openedAt.current < keyGraceMs) return;
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

  // The desktop shows the keys on the buttons instead of a footer line; a
  // confirm with no key line keeps its buttons plain there too.
  // One primary button, the one Enter answers.
  const keys = footer !== "";
  const confirmButton = (
    <Button
      label={confirmLabel}
      variant={enterCancels && confirmVariant === "primary" ? "secondary" : confirmVariant}
      disabled={busy}
      desktopShortcut={keys ? (enterCancels ? "Y" : "Enter") : undefined}
      onPress={confirm}
    />
  );
  const cancelButton = <Button label={cancelLabel} variant={enterCancels ? "primary" : "secondary"} disabled={busy} desktopShortcut={keys ? (enterCancels ? "Enter" : "Esc") : undefined} onPress={cancel} />;
  const keyLine = enterCancels
    ? tf("y {action} · Enter or Esc {cancel}", { action: t(confirmLabel).toLowerCase(), cancel: t(cancelLabel).toLowerCase() })
    : tf("Enter {action} · Esc cancel", { action: t(confirmLabel).toLowerCase() });
  return (
    <DialogFrame
      title={title}
      footer={footer ?? keyLine}
      desktopFooter={null}
      onClose={onClose}
    >
      <Box flexDirection="column" {...(desktop ? { style: { width: fitDialogWidth(width) } } : { width })}>
        {renderBody(body)}
        {status && (
          <>
            <Box height={1} />
            {status}
          </>
        )}
        <Box height={1} />
        <DialogActions alignEnd={formButtons}>
          {formButtons ? cancelButton : confirmButton}
          {formButtons ? confirmButton : cancelButton}
        </DialogActions>
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
