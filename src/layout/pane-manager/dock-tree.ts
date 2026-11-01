import {
  buildDockStack,
  isDockStack,
  type DockLayoutNode,
  type DockSplitNode,
  type LayoutConfig,
} from "../../types/config";

const MIN_PANE_WIDTH = 20;
const MIN_DOCKED_HEIGHT = 5;

export interface DockTarget {
  relativeTo: string;
  position: "left" | "right" | "above" | "below";
}

export interface LayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockLeafRef {
  instanceId: string;
  path: Array<0 | 1>;
  /** A tab of a stack: where the stack is, the spot the pane shares. */
  stackPath?: Array<0 | 1>;
}

/**
 * A spot of the dock on screen: one pane, or a stack of tabs showing
 * `instanceId` (its `path` is then the stack's).
 */
export interface DockLeafLayout extends DockLeafRef {
  rect: LayoutBounds;
  /** A stack: its tabs in order. */
  stack?: readonly string[];
}

export interface DockDividerLayout {
  path: Array<0 | 1>;
  axis: DockSplitNode["axis"];
  rect: LayoutBounds;
  bounds: LayoutBounds;
  ratio: number;
}

export interface DockResizeTarget extends DockDividerLayout {
  leafBranch: 0 | 1;
}

export interface DockGeometryOptions {
  precise?: boolean;
  dividerSize?: number | { horizontal: number; vertical: number };
  reserveDividerGutters?: boolean;
  /**
   * Precise only: the space left between two panes, in cells per axis (the
   * desktop's 4px). Each pane gives up half of it on the side it shares with
   * the other; the split and its divider stay where the ratio puts them.
   */
  gap?: number | { horizontal: number; vertical: number };
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(0.1, Math.min(0.9, ratio));
}

/** Every docked pane, tabs of a stack included, and where it is in the tree. */
export function collectDockLeafRefs(
  node: DockLayoutNode | null,
  path: Array<0 | 1> = [],
  result: DockLeafRef[] = [],
  stackPath?: Array<0 | 1>,
): DockLeafRef[] {
  if (!node) return result;
  if (node.kind === "pane") {
    result.push(stackPath ? { instanceId: node.instanceId, path, stackPath } : { instanceId: node.instanceId, path });
    return result;
  }
  const inStack = stackPath ?? (isDockStack(node) ? path : undefined);
  collectDockLeafRefs(node.first, [...path, 0], result, inStack);
  collectDockLeafRefs(node.second, [...path, 1], result, inStack);
  return result;
}

/** The pane a stack shows: its `active` tab, or its first when that is gone. */
export function dockStackShown(node: DockLayoutNode): string {
  const members = getDockedInstanceIds(node);
  return isDockStack(node) && members.includes(node.tabs.active) ? node.tabs.active : members[0]!;
}

export function getDockedInstanceIds(node: DockLayoutNode | null): string[] {
  return collectDockLeafRefs(node).map((entry) => entry.instanceId);
}

export function getRepresentativeLeafId(node: DockLayoutNode, preferStart: boolean): string {
  if (node.kind === "pane") return node.instanceId;
  if (isDockStack(node)) return dockStackShown(node);
  return getRepresentativeLeafId(preferStart ? node.first : node.second, preferStart);
}

export function getNodeAtPath(node: DockLayoutNode | null, path: Array<0 | 1>): DockLayoutNode | null {
  let current = node;
  for (const segment of path) {
    if (!current || current.kind !== "split") return null;
    current = segment === 0 ? current.first : current.second;
  }
  return current;
}

export function replaceNodeAtPath(node: DockLayoutNode, path: Array<0 | 1>, replacement: DockLayoutNode): DockLayoutNode {
  if (path.length === 0) return replacement;
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  if (head === 0) {
    return {
      ...node,
      first: replaceNodeAtPath(node.first, rest as Array<0 | 1>, replacement),
    };
  }
  return {
    ...node,
    second: replaceNodeAtPath(node.second, rest as Array<0 | 1>, replacement),
  };
}

export function removeNodeAtPath(node: DockLayoutNode | null, path: Array<0 | 1>): DockLayoutNode | null {
  if (!node) return null;
  if (path.length === 0) return null;
  if (node.kind !== "split") return node;
  if (isDockStack(node)) {
    // A tab leaves its stack; the stack shows the tab next to it if that was the one shown.
    const members = getDockedInstanceIds(node);
    const removed = getNodeAtPath(node, path);
    if (!removed) return node;
    const leaving = new Set(getDockedInstanceIds(removed));
    const kept = members.filter((id) => !leaving.has(id));
    const shown = dockStackShown(node);
    const index = members.indexOf(shown);
    const next = leaving.has(shown)
      ? members.slice(index + 1).find((id) => !leaving.has(id)) ?? kept.at(-1)
      : shown;
    return buildDockStack(kept, next);
  }

  const [head, ...rest] = path;
  if (head === 0) {
    const first = removeNodeAtPath(node.first, rest as Array<0 | 1>);
    if (!first) return node.second;
    return { ...node, first };
  }

  const second = removeNodeAtPath(node.second, rest as Array<0 | 1>);
  if (!second) return node.first;
  return { ...node, second };
}

export function buildSplitAroundNode(
  existing: DockLayoutNode,
  instanceId: string,
  position: DockTarget["position"],
): DockLayoutNode {
  const dragged: DockLayoutNode = { kind: "pane", instanceId };
  const axis = position === "left" || position === "right" ? "horizontal" : "vertical";
  const first = position === "left" || position === "above" ? dragged : existing;
  const second = position === "left" || position === "above" ? existing : dragged;
  return {
    kind: "split",
    axis,
    ratio: 0.5,
    first,
    second,
  };
}

function resolveSplitSizes(total: number, ratio: number, minSize: number, precise = false): [number, number] {
  if (precise) {
    if (total <= 0) return [0, 0];
    if (total <= 1) return [total, 0];
    if (total < minSize * 2) {
      const first = total / 2;
      return [first, total - first];
    }
    const preferred = total * clampRatio(ratio);
    const first = Math.max(minSize, Math.min(total - minSize, preferred));
    return [first, total - first];
  }

  if (total <= 1) return [1, 0];
  if (total < minSize * 2) {
    const first = Math.max(1, Math.floor(total / 2));
    return [first, Math.max(1, total - first)];
  }
  const preferred = Math.round(total * clampRatio(ratio));
  const first = Math.max(minSize, Math.min(total - minSize, preferred));
  return [first, total - first];
}

function collectDockGeometry(
  node: DockLayoutNode | null,
  bounds: LayoutBounds,
  path: Array<0 | 1> = [],
  leaves: DockLeafLayout[] = [],
  dividers: DockDividerLayout[] = [],
  options: DockGeometryOptions = {},
): { leaves: DockLeafLayout[]; dividers: DockDividerLayout[] } {
  if (!node) return { leaves, dividers };
  if (node.kind === "pane") {
    leaves.push({ instanceId: node.instanceId, path, rect: { ...bounds } });
    return { leaves, dividers };
  }
  if (isDockStack(node)) {
    // One spot, the tab shown; the splits that hold the tabs are not laid out.
    leaves.push({ instanceId: dockStackShown(node), path, rect: { ...bounds }, stack: getDockedInstanceIds(node) });
    return { leaves, dividers };
  }

  const precise = options.precise === true;
  const dividerSize = typeof options.dividerSize === "object"
    ? options.dividerSize[node.axis]
    : options.dividerSize ?? 1;
  const reserveDividerGutters = options.reserveDividerGutters === true && !precise;
  const gap = precise
    ? Math.max(0, typeof options.gap === "object" ? options.gap[node.axis] : options.gap ?? 0)
    : 0;

  if (node.axis === "horizontal") {
    const reserveDividerGutter = reserveDividerGutters && bounds.width > dividerSize;
    const splitWidth = reserveDividerGutter ? bounds.width - dividerSize : bounds.width;
    const [firstWidth, secondWidth] = resolveSplitSizes(splitWidth, node.ratio, MIN_PANE_WIDTH, precise);
    const halfGap = Math.min(gap / 2, firstWidth / 2, secondWidth / 2);
    const firstBounds = { x: bounds.x, y: bounds.y, width: firstWidth - halfGap, height: bounds.height };
    const dividerX = reserveDividerGutter
      ? bounds.x + firstWidth
      : precise
        ? bounds.x + firstWidth - (dividerSize / 2)
        : bounds.x + firstWidth - 1;
    const secondBounds = {
      x: reserveDividerGutter ? bounds.x + firstWidth + dividerSize : bounds.x + firstWidth + halfGap,
      y: bounds.y,
      width: secondWidth - halfGap,
      height: bounds.height,
    };
    dividers.push({
      path,
      axis: node.axis,
      bounds: { ...bounds },
      ratio: node.ratio,
      rect: {
        x: dividerX,
        y: bounds.y,
        width: dividerSize,
        height: bounds.height,
      },
    });
    collectDockGeometry(node.first, firstBounds, [...path, 0], leaves, dividers, options);
    collectDockGeometry(node.second, secondBounds, [...path, 1], leaves, dividers, options);
    return { leaves, dividers };
  }

  const reserveDividerGutter = reserveDividerGutters && bounds.height > dividerSize;
  const splitHeight = reserveDividerGutter ? bounds.height - dividerSize : bounds.height;
  const [firstHeight, secondHeight] = resolveSplitSizes(splitHeight, node.ratio, MIN_DOCKED_HEIGHT, precise);
  const halfGap = Math.min(gap / 2, firstHeight / 2, secondHeight / 2);
  const firstBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: firstHeight - halfGap };
  const dividerY = reserveDividerGutter
    ? bounds.y + firstHeight
    : precise
      ? bounds.y + firstHeight - (dividerSize / 2)
      : bounds.y + firstHeight - 1;
  const secondBounds = {
    x: bounds.x,
    y: reserveDividerGutter ? bounds.y + firstHeight + dividerSize : bounds.y + firstHeight + halfGap,
    width: bounds.width,
    height: secondHeight - halfGap,
  };
  dividers.push({
    path,
    axis: node.axis,
    bounds: { ...bounds },
    ratio: node.ratio,
    rect: {
      x: bounds.x,
      y: dividerY,
      width: bounds.width,
      height: dividerSize,
    },
  });
  collectDockGeometry(node.first, firstBounds, [...path, 0], leaves, dividers, options);
  collectDockGeometry(node.second, secondBounds, [...path, 1], leaves, dividers, options);
  return { leaves, dividers };
}

export function countColumnsFromGeometry(geometry: DockLeafLayout[]): number {
  if (geometry.length === 0) return 0;
  const midY = geometry.reduce((sum, entry) => sum + entry.rect.y + Math.floor(entry.rect.height / 2), 0) / geometry.length;
  return geometry.filter((entry) => midY >= entry.rect.y && midY < entry.rect.y + entry.rect.height).length;
}

export function getDockedPaneIds(layout: LayoutConfig): string[] {
  return getDockedInstanceIds(layout.dockRoot);
}

export function findDockLeaf(layout: LayoutConfig, instanceId: string): DockLeafRef | null {
  return collectDockLeafRefs(layout.dockRoot).find((entry) => entry.instanceId === instanceId) ?? null;
}

export function getDockLeafLayouts(layout: LayoutConfig, bounds: LayoutBounds, options?: DockGeometryOptions): DockLeafLayout[] {
  return collectDockGeometry(layout.dockRoot, bounds, [], [], [], options).leaves;
}

export function getDockDividerLayouts(layout: LayoutConfig, bounds: LayoutBounds, options?: DockGeometryOptions): DockDividerLayout[] {
  return collectDockGeometry(layout.dockRoot, bounds, [], [], [], options).dividers;
}

/**
 * The leaves and dividers under the split at `path`, laid out in `bounds`
 * (the split's own) as they will be once its ratio is `ratio`: what a divider
 * drag moves, as `resizeSplitAtPath` will lay it out, without the rest of the
 * tree. Null when no split is at `path`.
 */
export function getDockSplitGeometry(
  layout: LayoutConfig,
  path: Array<0 | 1>,
  bounds: LayoutBounds,
  ratio: number,
  options?: DockGeometryOptions,
): { leaves: DockLeafLayout[]; dividers: DockDividerLayout[] } | null {
  const node = getNodeAtPath(layout.dockRoot, path);
  if (!node || node.kind !== "split") return null;
  return collectDockGeometry({ ...node, ratio: clampRatio(ratio) }, bounds, path, [], [], options);
}

function isPathPrefix(prefix: Array<0 | 1>, path: Array<0 | 1>): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

export function getDockResizeTargets(
  layout: LayoutConfig,
  instanceId: string,
  bounds: LayoutBounds,
  options?: DockGeometryOptions,
): DockResizeTarget[] {
  const leaf = getDockLeafLayouts(layout, bounds, options).find((entry) => entry.instanceId === instanceId);
  if (!leaf || leaf.path.length === 0) return [];

  return getDockDividerLayouts(layout, bounds, options)
    .filter((divider) => isPathPrefix(divider.path, leaf.path) && divider.path.length < leaf.path.length)
    .map((divider) => ({
      ...divider,
      leafBranch: leaf.path[divider.path.length]!,
    }))
    .sort((left, right) => right.path.length - left.path.length);
}

/** The layout with `instanceId` shown in its stack: the same layout when it is not a tab, or is shown already. */
export function showDockTab(layout: LayoutConfig, instanceId: string): LayoutConfig {
  const leaf = findDockLeaf(layout, instanceId);
  if (!leaf?.stackPath || !layout.dockRoot) return layout;
  const stack = getNodeAtPath(layout.dockRoot, leaf.stackPath);
  if (!stack || !isDockStack(stack) || dockStackShown(stack) === instanceId) return layout;
  return {
    ...layout,
    dockRoot: replaceNodeAtPath(layout.dockRoot, leaf.stackPath, buildDockStack(getDockedInstanceIds(stack), instanceId)!),
  };
}
