import type {
  DockLayoutNode,
  DockSplitNode,
  LayoutConfig,
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
}

export interface DockLeafLayout extends DockLeafRef {
  rect: LayoutBounds;
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
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(0.1, Math.min(0.9, ratio));
}

export function collectDockLeafRefs(node: DockLayoutNode | null, path: Array<0 | 1> = [], result: DockLeafRef[] = []): DockLeafRef[] {
  if (!node) return result;
  if (node.kind === "pane") {
    result.push({ instanceId: node.instanceId, path });
    return result;
  }
  collectDockLeafRefs(node.first, [...path, 0], result);
  collectDockLeafRefs(node.second, [...path, 1], result);
  return result;
}

export function getDockedInstanceIds(node: DockLayoutNode | null): string[] {
  return collectDockLeafRefs(node).map((entry) => entry.instanceId);
}

export function getRepresentativeLeafId(node: DockLayoutNode, preferStart: boolean): string {
  if (node.kind === "pane") return node.instanceId;
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

  const precise = options.precise === true;
  const dividerSize = typeof options.dividerSize === "object"
    ? options.dividerSize[node.axis]
    : options.dividerSize ?? 1;
  const reserveDividerGutters = options.reserveDividerGutters === true && !precise;

  if (node.axis === "horizontal") {
    const reserveDividerGutter = reserveDividerGutters && bounds.width > dividerSize;
    const splitWidth = reserveDividerGutter ? bounds.width - dividerSize : bounds.width;
    const [firstWidth, secondWidth] = resolveSplitSizes(splitWidth, node.ratio, MIN_PANE_WIDTH, precise);
    const firstBounds = { x: bounds.x, y: bounds.y, width: firstWidth, height: bounds.height };
    const dividerX = reserveDividerGutter
      ? bounds.x + firstWidth
      : precise
        ? bounds.x + firstWidth - (dividerSize / 2)
        : bounds.x + firstWidth - 1;
    const secondBounds = {
      x: reserveDividerGutter ? bounds.x + firstWidth + dividerSize : bounds.x + firstWidth,
      y: bounds.y,
      width: secondWidth,
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
  const firstBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: firstHeight };
  const dividerY = reserveDividerGutter
    ? bounds.y + firstHeight
    : precise
      ? bounds.y + firstHeight - (dividerSize / 2)
      : bounds.y + firstHeight - 1;
  const secondBounds = {
    x: bounds.x,
    y: reserveDividerGutter ? bounds.y + firstHeight + dividerSize : bounds.y + firstHeight,
    width: bounds.width,
    height: secondHeight,
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
