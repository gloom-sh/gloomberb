import { useContext, type ReactNode } from "react";
import { useShortcut, type KeyEventLike, type ShortcutOptions } from "../react/input";
import { DialogContext } from "./dialog-context";

export interface AlertContext {
  dialogId?: string;
  dismiss(): void;
}

export interface PromptContext<T> extends AlertContext {
  resolve(value: T): void;
}

export type DialogSize = "small" | "medium" | "large" | "full";

/** Box overrides for the terminal dialog: a fixed width, caps, border or padding. */
export interface DialogStyle {
  width?: number;
  maxWidth?: number;
  maxHeight?: number;
  [key: string]: unknown;
}

/**
 * What `alert` and `prompt` open. `content` is the dialog body, or a function
 * of the dialog's context for a body that closes or answers it. `size` and
 * `style` size the terminal box; the desktop sizes a dialog to its content.
 */
export interface DialogOptions<C = AlertContext> {
  content?: ReactNode | ((context: C) => ReactNode);
  /**
   * Any string still compiles, so an options object built ahead (where "large"
   * widens to string) keeps working; the terminal treats an unknown size as medium.
   */
  size?: DialogSize | (string & {});
  style?: DialogStyle;
  /** Terminal: Esc closes the dialog unless this is false. The desktop always closes on Esc. */
  closeOnEscape?: boolean;
  /** A click on the backdrop closes the dialog. Off by default. */
  closeOnClickOutside?: boolean;
  /** Hosts ignore options they do not know. */
  [key: string]: unknown;
}

export interface DialogApi {
  alert(options: DialogOptions<AlertContext>): Promise<void>;
  prompt<T = string>(options: DialogOptions<PromptContext<T>>): Promise<T | undefined>;
}

export function DialogHostProvider({
  dialog,
  isOpen,
  dialogId,
  keyboardEnabled = true,
  children,
}: {
  dialog: DialogApi;
  isOpen: boolean;
  dialogId?: string;
  keyboardEnabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DialogContext value={{ dialog, isOpen, dialogId, keyboardEnabled }}>
      {children}
    </DialogContext>
  );
}

export function useDialog(): DialogApi {
  const context = useContext(DialogContext);
  if (!context) throw new Error("useDialog must be used inside DialogHostProvider");
  return context.dialog;
}

/** The dialog API when a host is mounted; null in isolated renders such as tests. */
export function useOptionalDialog(): DialogApi | null {
  return useContext(DialogContext)?.dialog ?? null;
}

export function useDialogState<T>(selector: (state: { isOpen: boolean }) => T): T {
  const context = useContext(DialogContext);
  if (!context) throw new Error("useDialogState must be used inside DialogHostProvider");
  return selector({ isOpen: context.isOpen });
}

export function useDialogKeyboard(
  handler: (event: KeyEventLike) => void,
  options?: ShortcutOptions | string,
): void {
  const context = useContext(DialogContext);
  const resolved = typeof options === "string" ? { scope: options } : options;
  useShortcut(handler, {
    ...resolved,
    enabled: (resolved?.enabled ?? true) && (context?.keyboardEnabled ?? true),
    scope: resolved?.scope ?? context?.dialogId,
  });
}
