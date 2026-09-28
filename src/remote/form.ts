import type { RemoteUiNodeSnapshot } from "./types";

/**
 * The open form or confirm, read from the node the form modal registers: its
 * kind, title, fields with their values and options, error, pending state and
 * submit label, and the node that cancels or sends it. `{ open: false }` when
 * none is open.
 */
export function formSnapshot(nodes: RemoteUiNodeSnapshot[]) {
  const node = nodes.filter((entry) => entry.role === "form" && entry.metadata?.scope === "form").at(-1);
  if (!node) return { open: false };
  const { scope: _scope, ...form } = node.metadata ?? {};
  return { open: true, nodeId: node.id, actions: node.actions, ...form };
}
