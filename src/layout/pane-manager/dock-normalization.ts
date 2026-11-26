import type { DockLayoutNode, DockSplitNode } from "../../types/config";
import { buildDockStack } from "./dock-stack";

function clampDockRatio(ratio: number | undefined): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 0.5;
  return Math.max(0.1, Math.min(0.9, ratio));
}

function isDockAxis(value: unknown): value is DockSplitNode["axis"] {
  return value === "horizontal" || value === "vertical";
}

export function getDockedPaneIdsFromNode(node: DockLayoutNode | null, result: string[] = []): string[] {
  if (!node) return result;
  if (node.kind === "pane") {
    result.push(node.instanceId);
    return result;
  }
  getDockedPaneIdsFromNode(node.first, result);
  getDockedPaneIdsFromNode(node.second, result);
  return result;
}

export function normalizeDockNode(
  node: DockLayoutNode | null | undefined,
  validInstanceIds: Set<string>,
  seenPaneIds: Set<string>,
): DockLayoutNode | null {
  if (!node || typeof node !== "object") return null;

  if (node.kind === "pane") {
    const { instanceId } = node;
    if (typeof instanceId !== "string" || !validInstanceIds.has(instanceId) || seenPaneIds.has(instanceId)) {
      return null;
    }
    seenPaneIds.add(instanceId);
    return { kind: "pane", instanceId };
  }

  if (node.kind !== "split") return null;
  if (node.tabs) {
    // Whatever is under a stack is its tabs, nested or not: a pane put back
    // at a place inside it (its remembered spot) joins it.
    const plain: DockSplitNode = { kind: "split", axis: node.axis, ratio: node.ratio, first: node.first, second: node.second };
    const flat = normalizeDockNode(plain, validInstanceIds, seenPaneIds);
    const active = typeof node.tabs.active === "string" ? node.tabs.active : null;
    return flat ? buildDockStack(getDockedPaneIdsFromNode(flat), active) : null;
  }
  const first = normalizeDockNode(node.first, validInstanceIds, seenPaneIds);
  const second = normalizeDockNode(node.second, validInstanceIds, seenPaneIds);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return {
    kind: "split",
    axis: isDockAxis(node.axis) ? node.axis : "horizontal",
    ratio: clampDockRatio(node.ratio),
    first,
    second,
  };
}
