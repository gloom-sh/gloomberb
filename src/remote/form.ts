import type { RemoteUiNodeSnapshot } from "./types";

/**
 * The open form or confirm, read from the node the form modal registers: its
 * kind, title, fields with their values and options, error, pending state and
 * submit label, and the node that cancels or sends it. `covered` when another
 * dialog (a listing picker, a sign-in) sits over it. `{ open: false }` when
 * none is open, with `otherDialogOpen` while a dialog that is not a form (pane
 * settings) is.
 */
export function formSnapshot(nodes: RemoteUiNodeSnapshot[], dialogOpen: boolean) {
  const node = findFormNode(nodes);
  if (!node) return dialogOpen ? { open: false, otherDialogOpen: true } : { open: false };
  const { scope: _scope, covered, ...form } = node.metadata ?? {};
  return { open: true, nodeId: node.id, actions: node.actions, ...form, ...(covered === true ? { covered } : {}) };
}

export function findFormNode(nodes: RemoteUiNodeSnapshot[]): RemoteUiNodeSnapshot | undefined {
  return nodes.filter((entry) => entry.role === "form" && entry.metadata?.scope === "form").at(-1);
}
