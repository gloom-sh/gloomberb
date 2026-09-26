/** @jsxImportSource react */
import { useEffect, useRef, type ReactNode } from "react";
import { DialogHostProvider } from "../../../ui/dialog";
import { useDialogStack } from "../../../ui/dialog-stack";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { isEditableTarget, isInsideDialogSurface } from "./host/focus-scope";

interface DialogState {
  id: string;
  content: ReactNode | ((context: { dialogId: string; dismiss(): void; resolve(value: unknown): void }) => ReactNode);
  closeOnClickOutside: boolean;
  returnFocus: HTMLElement | null;
}

/**
 * Dialogs stack, as they do in the terminal: a dialog opened from another one
 * (a field editor from pane settings) sits on top, and closing it returns to
 * the one underneath with its keyboard state intact.
 */
export function WebDialogHostProvider({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const dialogElementsRef = useRef(new Map<string, HTMLDivElement>());
  const dialogBorder = blendHex(colors.border, colors.borderFocused, 0.18);
  const dialogBg = blendHex(colors.panel, colors.bg, 0.12);
  const { dialogs, close, api } = useDialogStack<DialogState>({
    idPrefix: "web-dialog",
    createEntry: (id, _kind, options) => {
      const activeElement = document.activeElement;
      // Focus goes back to a field or to the dialog underneath. A button a
      // pointer pressed in a pane would take the next Enter for itself.
      const returnFocus = activeElement instanceof HTMLElement
        && (isEditableTarget(activeElement) || isInsideDialogSurface(activeElement))
        ? activeElement
        : null;
      return {
        id,
        content: options.content as DialogState["content"],
        closeOnClickOutside: options.closeOnClickOutside === true,
        returnFocus,
      };
    },
    onClosed: (dialog) => {
      queueMicrotask(() => {
        if (dialog.returnFocus?.isConnected) {
          dialog.returnFocus.focus({ preventScroll: true });
        }
      });
    },
  });

  const topmost = dialogs[dialogs.length - 1] ?? null;

  useEffect(() => {
    if (!topmost) return;
    const frame = requestAnimationFrame(() => {
      const dialogElement = dialogElementsRef.current.get(topmost.id);
      // Leave focus alone when the dialog content already owns it.
      if (dialogElement && !dialogElement.contains(document.activeElement)) {
        dialogElement.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [topmost?.id]);

  useEffect(() => {
    if (!topmost) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      // Older WebViews report Escape as "Esc".
      if (event.isComposing || (event.key !== "Escape" && event.key !== "Esc")) return;
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
