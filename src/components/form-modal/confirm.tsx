import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { useViewport } from "../../react/input";
import { useThemeColors } from "../../theme/theme-context";
import { Text } from "../../ui";
import type { AlertContext } from "../../ui/dialog";
import { useDialogIsTopmost } from "../../ui/dialog-context";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Spinner } from "../ui/loading";
import { TERMINAL_DIALOG_INSET, type FormModalRuntime } from "./content";
import type { ConfirmModalOptions } from "./request";

/** Confirms say one or two lines; they do not need a form's width. */
export const CONFIRM_MODAL_WIDTH = 60;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("Could not complete that action.");
}

/**
 * The bar's confirms named their cancel "Back", which returned to the list the
 * confirm came from. The modal opens after the bar closed, so there is nothing
 * to go back to.
 */
function confirmCancelLabel(label: string | undefined): string {
  return !label || label === "Back" ? "Cancel" : label;
}

export function ConfirmModalContent({
  confirm,
  dialogId,
  dismiss,
  runtime,
  width,
}: AlertContext & {
  confirm: ConfirmModalOptions;
  runtime: FormModalRuntime;
  /** Dialog width in cells, the frame included. */
  width: number;
}) {
  useAppLanguage();
  const colors = useThemeColors();
  const viewport = useViewport();
  const isTopmost = useDialogIsTopmost();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter can repeat faster than a render; one confirm runs once. The kit's
  // confirm keys (Enter or y, n or Esc) and buttons all reach `run`.
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    runtime.bindDismiss(dismiss);
    return () => runtime.bindDismiss(null);
  }, [dismiss, runtime]);

  const run = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await confirm.onConfirm();
    } catch (failure) {
      pendingRef.current = false;
      if (!mountedRef.current) {
        // Closed while it ran: the inline error has nowhere to go.
        runtime.getDeps().pluginRegistry.notify({ body: errorMessage(failure), type: "error" });
        return;
      }
      setPending(false);
      setError(errorMessage(failure));
      return;
    }
    pendingRef.current = false;
    // Closed while it ran: the user has moved on, and what onSuccess opens
    // (the bar again) would land over whatever they are doing now.
    if (!mountedRef.current) return;
    if (confirm.successBehavior === "stay") setPending(false);
    else dismiss();
    // After the confirm closed, so what it opens (the bar again) is not over it.
    confirm.onSuccess?.();
  }, [confirm, dismiss, runtime]);

  // What remote control reads as app://form, and a way to cancel or confirm.
  useRemoteUiNode({
    role: "form",
    label: t(confirm.title),
    actions: {
      cancel: dismiss,
      submit: () => { void run(); },
    },
    getMetadata: () => ({
      scope: "form",
      kind: "confirm",
      title: t(confirm.title),
      body: confirm.body.map((line) => t(line)),
      fields: [],
      error: error ? t(error) : null,
      pending,
      submitLabel: t(confirm.confirmLabel),
      covered: !isTopmost,
    }),
  });

  // The dialog's width less its frame, and never wider than the window.
  const contentWidth = Math.max(10, Math.min(width, Math.max(1, viewport.width - 2)) - TERMINAL_DIALOG_INSET);
  const status = error
    ? <Text fg={colors.negative} wrapText>{t(error)}</Text>
    : pending ? <Spinner label={t("Working…")} /> : null;

  // The kit's confirm, with the work it starts shown in it, framed as the
  // modal's forms are: no key-hint line, the desktop close button, and Cancel
  // before the action at the right.
  return (
    <ConfirmDialog
      dialogId={dialogId}
      dismiss={dismiss}
      onClose={dismiss}
      footer=""
      formButtons
      resolve={(confirmed) => {
        if (confirmed) void run();
        else dismiss();
      }}
      title={confirm.title}
      body={confirm.body}
      confirmLabel={t(confirm.confirmLabel)}
      cancelLabel={t(confirmCancelLabel(confirm.cancelLabel))}
      confirmVariant={confirm.tone === "default" ? "primary" : "danger"}
      width={contentWidth}
      status={status}
      busy={pending}
    />
  );
}
