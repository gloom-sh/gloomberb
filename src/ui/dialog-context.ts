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
