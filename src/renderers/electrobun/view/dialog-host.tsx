/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DialogHostProvider, type DialogApi } from "../../../ui/dialog";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { isEditableTarget, isInsideDialogSurface } from "./host/focus-scope";

interface DialogState {
  id: string;
  content: ReactNode | ((context: { dialogId: string; dismiss(): void; resolve(value: unknown): void }) => ReactNode);
  closeOnClickOutside: boolean;
  returnFocus: HTMLElement | null;
  resolve(value: unknown): void;
}

let nextDialogId = 1;

export function isDialogDismissKey(event: Pick<KeyboardEvent, "key" | "isComposing">): boolean {
  return !event.isComposing && (event.key === "Escape" || event.key === "Esc");
}

export function shouldFocusDialogContainer(
  dialog: Pick<HTMLElement, "contains">,
  activeElement: Element | null,
): boolean {
  return activeElement === null || !dialog.contains(activeElement);
}

/**
 * Dialogs stack, as they do in the terminal: a dialog opened from another one
 * (a field editor from pane settings) sits on top, and closing it returns to
 * the one underneath with its keyboard state intact.
 */
export function WebDialogHostProvider({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const [dialogs, setDialogs] = useState<DialogState[]>([]);
  const dialogsRef = useRef<DialogState[]>([]);
  const dialogElementsRef = useRef(new Map<string, HTMLDivElement>());
  const dialogBorder = blendHex(colors.border, colors.borderFocused, 0.18);
  const dialogBg = blendHex(colors.panel, colors.bg, 0.12);

  const close = useCallback((id: string, value?: unknown) => {
    const current = dialogsRef.current.find((dialog) => dialog.id === id);
    if (!current) return;
    const next = dialogsRef.current.filter((dialog) => dialog.id !== id);
    dialogsRef.current = next;
    setDialogs(next);
    current.resolve(value);
    queueMicrotask(() => {
      if (current.returnFocus?.isConnected) {
        current.returnFocus.focus({ preventScroll: true });
      }
    });
  }, []);

  const open = useCallback(function openDialog<T>(options: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve) => {
      const activeElement = document.activeElement;
      // Focus goes back to a field or to the dialog underneath. A button a
      // pointer pressed in a pane would take the next Enter for itself.
      const returnFocus = activeElement instanceof HTMLElement
        && (isEditableTarget(activeElement) || isInsideDialogSurface(activeElement))
        ? activeElement
        : null;
      const next: DialogState = {
        id: `web-dialog-${nextDialogId++}`,
        content: options.content as DialogState["content"],
        closeOnClickOutside: options.closeOnClickOutside === true,
        returnFocus,
        resolve: (value) => resolve(value as T),
      };
      dialogsRef.current = [...dialogsRef.current, next];
      setDialogs(dialogsRef.current);
    });
  }, []);

  const topmost = dialogs[dialogs.length - 1] ?? null;

  useEffect(() => {
    if (!topmost) return;
    const frame = requestAnimationFrame(() => {
      const dialogElement = dialogElementsRef.current.get(topmost.id);
      if (
        dialogElement
        && shouldFocusDialogContainer(dialogElement, document.activeElement)
      ) {
        dialogElement.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [topmost?.id]);

  useEffect(() => {
    if (!topmost) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (!isDialogDismissKey(event)) return;
      // A menu open inside the dialog (a select field) closes first; the next
      // Esc closes the dialog.
      if (document.querySelector(".gloom-popover")) return;
      event.preventDefault();
      event.stopPropagation();
      close(topmost.id, undefined);
    };
    window.addEventListener("keydown", dismissOnEscape, true);
    return () => window.removeEventListener("keydown", dismissOnEscape, true);
  }, [close, topmost?.id]);

  // Settle anything still open if the host goes away.
  useEffect(() => () => {
    for (const dialog of dialogsRef.current) dialog.resolve(undefined);
    dialogsRef.current = [];
  }, []);

  const api = useMemo<DialogApi>(() => ({
    alert: open,
    prompt: open,
  }), [open]);

  return (
    <DialogHostProvider dialog={api} isOpen={dialogs.length > 0}>
      {children}
      {dialogs.map((dialogState, index) => {
        const isTopmost = index === dialogs.length - 1;
        return (
          <div
            key={dialogState.id}
            className="gloom-dialog-backdrop"
            data-topmost={isTopmost ? "true" : "false"}
            onMouseDown={(event) => {
              if (
                isTopmost
                && dialogState.closeOnClickOutside
                && event.target === event.currentTarget
              ) {
                close(dialogState.id, undefined);
              }
            }}
          >
            <div
              ref={(element) => {
                if (element) dialogElementsRef.current.set(dialogState.id, element);
                else dialogElementsRef.current.delete(dialogState.id);
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Dialog"
              aria-hidden={isTopmost ? undefined : true}
              tabIndex={-1}
              className="gloom-dialog"
              style={{
                borderColor: dialogBorder,
                background: dialogBg,
                color: colors.text,
              }}
            >
              <DialogHostProvider
                dialog={api}
                isOpen
                dialogId={dialogState.id}
                keyboardEnabled={isTopmost}
              >
                {typeof dialogState.content === "function"
                  ? dialogState.content({
                    dialogId: dialogState.id,
                    dismiss: () => close(dialogState.id, undefined),
                    resolve: (value) => close(dialogState.id, value),
                  })
                  : dialogState.content}
              </DialogHostProvider>
            </div>
          </div>
        );
      })}
    </DialogHostProvider>
  );
}
