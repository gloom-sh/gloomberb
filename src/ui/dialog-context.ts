import { createContext, useContext } from "react";
import type { DialogApi } from "./dialog";

/**
 * The context behind `gloomberb/dialog`, kept in its own module so the host
 * can read more of it than the public hooks expose.
 */
export interface DialogContextValue {
  dialog: DialogApi;
  isOpen: boolean;
  dialogId?: string;
  keyboardEnabled: boolean;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

/**
 * False while another dialog is stacked over this one. A field that stays
 * focused under a stacked picker would take its keys, so dialog inputs pass
 * this into `focused`. True outside any dialog.
 */
export function useDialogIsTopmost(): boolean {
  return useContext(DialogContext)?.keyboardEnabled ?? true;
}

/**
 * True while any dialog is open, so it has the keyboard. False outside a
 * dialog host (a pane drawn on its own), where `useDialogState` throws.
 */
export function useAnyDialogOpen(): boolean {
  return useContext(DialogContext)?.isOpen ?? false;
}
