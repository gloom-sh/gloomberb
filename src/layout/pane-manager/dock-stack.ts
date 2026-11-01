import type { DockLayoutNode, DockSplitNode } from "../../types/config";

/**
 * Panes stacked as tabs in one spot of the dock, one shown at a time: the
 * panes of the subtree, first to last, as a chain of splits that each carry
 * `tabs`. A build from before tabs reads the chain as a plain split and shows
 * the panes side by side instead of losing them, and a split that loses one
 * side is still a stack.
 */
export type DockStackNode = DockSplitNode & { tabs: { active: string } };

export function isDockStack(node: DockLayoutNode | null | undefined): node is DockStackNode {
  return node?.kind === "split" && !!node.tabs;
}

/**
 * The stack of `instanceIds` showing `active` (the first when it is not one
 * of them), in its stored form; one pane is a plain pane, none is nothing.
 */
export function buildDockStack(instanceIds: readonly string[], active?: string | null): DockLayoutNode | null {
  const ids = [...new Set(instanceIds)];
  if (ids.length === 0) return null;
  const shown = active && ids.includes(active) ? active : ids[0]!;
  const chain = (index: number): DockLayoutNode => {
    if (index === ids.length - 1) return { kind: "pane", instanceId: ids[index]! };
    return {
      kind: "split",
      axis: "horizontal",
      // Even widths where a build from before tabs shows them side by side
      // (as far as a split's 0.1 to 0.9 allows).
      ratio: Math.max(0.1, Math.min(0.9, 1 / (ids.length - index))),
      first: { kind: "pane", instanceId: ids[index]! },
      second: chain(index + 1),
      tabs: { active: shown },
    };
  };
  return chain(0);
}
