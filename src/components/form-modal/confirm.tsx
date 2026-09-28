import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { useViewport, type KeyEventLike } from "../../react/input";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../ui";
import { useDialogKeyboard, type AlertContext } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { Button } from "../ui/button";
import { DialogFrame } from "../ui/frame";
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
export function confirmCancelLabel(label: string | undefined): string {
  return !label || label === "Back" ? "Cancel" : label;
}

function isCommit(event: KeyEventLike): boolean {
  return event.name === "return" || event.name === "enter";
}

export function ConfirmModalContent({
  confirm,
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
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const viewport = useViewport();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter can repeat faster than a render; one confirm runs once.
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
    if (!mountedRef.current) return;
    if (confirm.successBehavior === "stay") {
      setPending(false);
      return;
    }
    dismiss();
  }, [confirm, dismiss, runtime]);

  // Every key, even with a field focused underneath: a confirm has nothing to
  // type into, so nothing below should take one.
  useDialogKeyboard((event) => {
    // Esc belongs to the dialog host, which closes the confirm even mid-run.
    if (event.name === "escape") return;
    event.stopPropagation();
    if (pendingRef.current) {
      event.preventDefault();
      return;
    }
    if (isCommit(event) || isPlainKey(event, "y")) {
      event.preventDefault();
      void run();
      return;
    }
    if (isPlainKey(event, "n")) {
      event.preventDefault();
      dismiss();
      return;
    }
    // Two buttons and nothing to type: Tab has nowhere to go.
    if (event.name === "tab") event.preventDefault();
  }, { allowEditable: true });

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
    }),
  });

  const modalWidth = Math.min(width, Math.max(1, viewport.width - 2));
  const contentWidth = Math.max(10, modalWidth - TERMINAL_DIALOG_INSET);

  const body = confirm.body.map((line, index) => (
    <Text key={`body:${index}`} fg={index === 0 ? colors.text : colors.textDim} wrapText>{t(line)}</Text>
  ));
  const status = error
    ? <Text fg={colors.negative} wrapText>{t(error)}</Text>
    : pending ? <Spinner label={t("Working…")} /> : null;
  const buttons = (
    <Box flexDirection="row" gap={1} justifyContent="flex-end">
      <Button label={t(confirmCancelLabel(confirm.cancelLabel))} variant="secondary" disabled={pending} onPress={dismiss} />
      <Button
        label={t(confirm.confirmLabel)}
        variant={confirm.tone === "default" ? "primary" : "danger"}
        disabled={pending}
        onPress={() => { void run(); }}
      />
    </Box>
  );

  if (desktop) {
    return (
      <Box width={width} maxWidth="calc(100vw - 72px)" flexDirection="column">
        <DialogFrame title={confirm.title} onClose={dismiss}>
          <Box flexDirection="column">{body}</Box>
          {status && <Box flexDirection="column" style={{ marginTop: 10 }}>{status}</Box>}
          <Box style={{ marginTop: 14 }}>{buttons}</Box>
        </DialogFrame>
      </Box>
    );
  }

  return (
    <DialogFrame title={confirm.title}>
      <Box flexDirection="column" width={contentWidth}>
        {body}
        {status && (
          <>
            <Box height={1} />
            {status}
          </>
        )}
        <Box height={1} />
        {buttons}
      </Box>
    </DialogFrame>
  );
}
