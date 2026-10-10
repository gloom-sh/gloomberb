import type { DockLayoutNode, DockSplitNode, LayoutConfig, PaneInstanceConfig } from "../../types/config";
import { collectDockLeafRefs, getDockedInstanceIds, getNodeAtPath, replaceNodeAtPath } from "./dock-tree";

/**
 * A hidden part of the saved dock tree: the largest subtree with no pane on
 * screen, and where it sat beside the panes that are.
 */
interface HiddenDockBranch {
  node: DockLayoutNode;
  axis: DockSplitNode["axis"];
  ratio: number;
  /** Which child of its split it was. */
  side: 0 | 1;
  /** The shown panes on the other side of that split. */
  besideIds: ReadonlySet<string>;
  depth: number;
}

function isAllHidden(node: DockLayoutNode, hidden: ReadonlySet<string>): boolean {
  return getDockedInstanceIds(node).every((instanceId) => hidden.has(instanceId));
}

function collectHiddenBranches(
  node: DockLayoutNode,
  hidden: ReadonlySet<string>,
  depth: number,
  out: HiddenDockBranch[],
): void {
  if (node.kind !== "split") return;
  const children = [node.first, node.second] as const;
  children.forEach((child, index) => {
    const side = index as 0 | 1;
    if (!isAllHidden(child, hidden)) {
      collectHiddenBranches(child, hidden, depth + 1, out);
      return;
    }
    const sibling = children[1 - side]!;
    out.push({
      node: child,
      axis: node.axis,
      ratio: node.ratio,
      side,
      besideIds: new Set(getDockedInstanceIds(sibling).filter((instanceId) => !hidden.has(instanceId))),
      depth,
    });
  });
}

function commonPathPrefix(paths: ReadonlyArray<ReadonlyArray<0 | 1>>): Array<0 | 1> {
  const [first, ...rest] = paths;
  if (!first) return [];
  let length = first.length;
  for (const path of rest) {
    let index = 0;
    while (index < length && index < path.length && path[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length);
}

/**
 * Puts a hidden branch back beside the smallest subtree that holds the panes
 * it sat beside, or beside everything when those are gone. Branches put back
 * first sat deeper, so the target grows over them to keep the old nesting.
 */
function reattachBranch(
  root: DockLayoutNode | null,
  branch: HiddenDockBranch,
  hidden: ReadonlySet<string>,
): DockLayoutNode {
  if (!root) return branch.node;
  const beside = collectDockLeafRefs(root).filter((leaf) => branch.besideIds.has(leaf.instanceId));
  let path = beside.length > 0 ? commonPathPrefix(beside.map((leaf) => leaf.path)) : [];
  while (path.length > 0) {
    const parent = getNodeAtPath(root, path.slice(0, -1));
    if (parent?.kind !== "split") break;
    const sibling = path[path.length - 1] === 0 ? parent.second : parent.first;
    if (!isAllHidden(sibling, hidden)) break;
    path = path.slice(0, -1);
  }
  const target = getNodeAtPath(root, path) ?? root;
  const split: DockSplitNode = {
    kind: "split",
    axis: branch.axis,
    ratio: branch.ratio,
    first: branch.side === 0 ? branch.node : target,
    second: branch.side === 0 ? target : branch.node,
  };
  return replaceNodeAtPath(root, path, split);
}

function restoreHiddenDockTree(
  saved: DockLayoutNode | null,
  edited: DockLayoutNode | null,
  hidden: ReadonlySet<string>,
): DockLayoutNode | null {
  if (!saved || !getDockedInstanceIds(saved).some((instanceId) => hidden.has(instanceId))) return edited;
  if (isAllHidden(saved, hidden)) {
    return edited ? { kind: "split", axis: "horizontal", ratio: 0.5, first: saved, second: edited } : saved;
  }
  const branches: HiddenDockBranch[] = [];
  collectHiddenBranches(saved, hidden, 0, branches);
  branches.sort((a, b) => b.depth - a.depth);
  let root = edited;
  for (const branch of branches) root = reattachBranch(root, branch, hidden);
  return root;
}

/**
 * The edited list with each hidden entry back after the entry it followed in
 * the saved one, so the order of what is on screen stays the edit's.
 */
function restoreHiddenEntries<T extends { instanceId: string }>(
  saved: readonly T[],
  edited: readonly T[],
  hidden: ReadonlySet<string>,
): T[] {
  if (!saved.some((entry) => hidden.has(entry.instanceId))) return [...edited];
  const result = [...edited];
  let previousId: string | null = null;
  for (const entry of saved) {
    if (hidden.has(entry.instanceId)) {
      const index = previousId === null ? -1 : result.findIndex((candidate) => candidate.instanceId === previousId);
      result.splice(index + 1, 0, entry);
      previousId = entry.instanceId;
    } else if (result.some((candidate) => candidate.instanceId === entry.instanceId)) {
      previousId = entry.instanceId;
    }
  }
  return result;
}

/**
 * Panes whose plugin is off, or whose pane type nothing registered, stay in
 * the saved layout while the shell leaves them off screen. The shell edits
 * the layout it shows, so before an edit is saved this puts every hidden pane
 * back from `saved`: its instance and state, its floating or popped-out frame,
 * and its docked branch beside the panes it sat next to. A hidden pane the
 * edit itself kept is left as the edit has it.
 *
 * With nothing edited, `restoreHiddenPanes(saved, shown)` is `saved` again.
 */
export function restoreHiddenPanes(
  saved: LayoutConfig,
  edited: LayoutConfig,
  isHidden: (instance: PaneInstanceConfig) => boolean,
): LayoutConfig {
  const editedIds = new Set(edited.instances.map((instance) => instance.instanceId));
  const hidden = new Set(saved.instances
    .filter((instance) => !editedIds.has(instance.instanceId) && isHidden(instance))
    .map((instance) => instance.instanceId));
  if (hidden.size === 0) return edited;
  return {
    ...edited,
    dockRoot: restoreHiddenDockTree(saved.dockRoot, edited.dockRoot, hidden),
    instances: restoreHiddenEntries(saved.instances, edited.instances, hidden),
    floating: restoreHiddenEntries(saved.floating, edited.floating, hidden),
    detached: restoreHiddenEntries(saved.detached ?? [], edited.detached ?? [], hidden),
  };
}
