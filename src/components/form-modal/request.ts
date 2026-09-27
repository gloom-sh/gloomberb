import type { TickerRecord } from "../../types/ticker";
import type { CommandBarWorkflowRoute } from "../command-bar/workflow/types";

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
  | { kind: "route"; route: CommandBarWorkflowRoute };

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

export function subscribeFormModalRequests(listener: FormModalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
