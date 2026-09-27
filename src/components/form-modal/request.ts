import type { TickerRecord } from "../../types/ticker";
import type { CommandBarWorkflowRoute } from "../command-bar/workflow/types";

/** A yes-or-no question before an action that is hard to take back. */
export interface ConfirmModalOptions {
  confirmId: string;
  title: string;
  body: string[];
  confirmLabel: string;
  /** Shown as "Cancel" when missing or "Back". */
  cancelLabel?: string;
  /** Danger unless said otherwise: most confirms guard a deletion. */
  tone?: "default" | "danger";
  /** Reads what it acts on when it runs, not when the confirm opened. */
  onConfirm: () => void | Promise<void>;
  /** "stay" keeps the confirm open after it ran; "back" closes it, as "close" does. */
  successBehavior?: "close" | "back" | "stay";
}

/**
 * What to fill in. The host builds the form when it opens, from the state at
 * that moment, so a launch from a menu, a pane or the bar needs no builder of
 * its own.
 */
export type FormModalRequest =
  | { kind: "builtin"; actionId: string }
  | { kind: "plugin-command"; commandId: string; values?: Record<string, string> }
  | { kind: "pane-template"; templateId: string; arg?: string }
  | { kind: "add-to-portfolio"; ticker: TickerRecord; portfolioId?: string | null }
  | { kind: "route"; route: CommandBarWorkflowRoute }
  | { kind: "confirm"; confirm: ConfirmModalOptions };

type FormModalListener = (request: FormModalRequest) => boolean;

const listeners = new Set<FormModalListener>();

/**
 * Opens a form in the central modal. False when no host is mounted (a
 * detached window, an isolated render) or a form is already open.
 */
export function openFormModal(request: FormModalRequest): boolean {
  // One host answers: the newest, as an older one is on its way out.
  const host = [...listeners].at(-1);
  return host ? host(request) : false;
}

/** Opens a confirm in the same modal. False when a form or confirm is already open. */
export function openConfirmModal(confirm: ConfirmModalOptions): boolean {
  return openFormModal({ kind: "confirm", confirm });
}

export function subscribeFormModalRequests(listener: FormModalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
