import { optionalNumber, optionalString } from "./controller-utils";
import { findFormNode } from "./form";
import type { RemoteUiNodeSnapshot } from "./types";
import { asRecord } from "../utils/guards";

/** The visible command-bar row commandBar.activateResult picks for this input. */
export function findCommandBarResult<T extends { nodeId: string; itemId?: unknown; label?: unknown; index?: unknown; selected: boolean }>(
  results: readonly T[],
  input: Record<string, unknown>,
): T | undefined {
  const nodeId = optionalString(input, "nodeId");
  const index = optionalNumber(input, "index");
  const itemId = optionalString(input, "itemId");
  const label = optionalString(input, "label");
  return nodeId
    ? results.find((entry) => entry.nodeId === nodeId)
    : itemId
      ? results.find((entry) => entry.itemId === itemId)
      : label
        ? results.find((entry) => entry.label === label)
    : typeof index === "number"
      ? results.find((entry) => entry.index === index)
      : results.find((entry) => entry.selected) ?? results[0];
}

/** The semantic UI node ui.invokeMatching acts on for this input, or undefined. */
export function findMatchingUiNode(
  nodes: RemoteUiNodeSnapshot[],
  input: Record<string, unknown>,
): RemoteUiNodeSnapshot | undefined {
  const role = optionalString(input, "role");
  const label = optionalString(input, "label");
  const contains = optionalString(input, "contains");
  const index = optionalNumber(input, "index");
  const action = optionalString(input, "action") ?? "press";
  const metadataFilter = asRecord(input.metadata);
  // A dialog over the form (a listing picker, a sign-in) keeps its controls
  // out of reach, as it does from the mouse.
  const formCovered = findFormNode(nodes)?.metadata?.covered === true;
  const candidates = nodes.filter((node) => {
    if (formCovered && node.metadata?.scope === "form") return false;
    if (role && node.role !== role) return false;
    if (label && node.label !== label && node.metadata?.item && typeof node.metadata.item === "object") {
      const item = node.metadata.item as Record<string, unknown>;
      if (item.label !== label && item.id !== label) return false;
    } else if (label && node.label !== label) {
      return false;
    }
    if (contains) {
      const haystack = [
        node.label,
        node.role,
        JSON.stringify(node.metadata ?? {}),
      ].filter((entry): entry is string => typeof entry === "string").join(" ").toLowerCase();
      if (!haystack.includes(contains.toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(metadataFilter)) {
      if (node.metadata?.[key] !== value) return false;
    }
    if (!node.actions.includes(action)) return false;
    if (node.disabled) return false;
    return true;
  });
  // An open form or confirm covers every pane, so its own controls come
  // first: its Cancel, not a pane's Cancel behind it.
  const inForm = candidates.filter((node) => node.metadata?.scope === "form");
  const matches = inForm.length > 0 ? inForm : candidates;
  return typeof index === "number" ? matches[index] : matches[0];
}
