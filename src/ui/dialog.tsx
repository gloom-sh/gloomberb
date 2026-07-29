import { createContext, useContext, type ReactNode } from "react";
import { useShortcut, type KeyEventLike, type ShortcutOptions } from "../react/input";

export interface AlertContext {
  dialogId?: string;
  dismiss(): void;
}

export interface PromptContext<T> extends AlertContext {
  resolve(value: T): void;
}

export interface DialogApi {
  alert(options: Record<string, unknown>): Promise<void>;
  prompt<T = string>(options: Record<string, unknown>): Promise<T | undefined>;
}

interface DialogContextValue {
  dialog: DialogApi;
  isOpen: boolean;
  dialogId?: string;
  keyboardEnabled: boolean;
}

const DialogContext = createContext<DialogContextValue | null>(null);

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
