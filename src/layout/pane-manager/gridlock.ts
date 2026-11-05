import type { DockLayoutNode, FloatingPaneEntry, LayoutConfig } from "../../types/config";
import { buildDockStack, isDockStack } from "./dock-stack";
import type { AppNotificationRequest } from "../../types/plugin";
import {
  boundsForRects,
  buildGridDockTree,
  inferDockTreeFromRects,
  type GridlockRect,
} from "./gridlock-inference";
import {
  getDockLeafLayouts,
  type LayoutBounds,
} from "./dock-tree";
import {
  finalizeLayout,
  removeUnavailablePaneTypes,
  type PaneTypeAvailability,
} from "./layout-state";

const BURIED_VISIBLE_RATIO = 0.2;
const TITLE_BAR_HEIGHT_RATIO = 0.12;
const TIDY_FLOATING_THRESHOLD = 3;
/** Below this many columns Tidy stacks the panes in one column instead of tiling a grid of slivers. */
const NARROW_TIDY_WIDTH = 80;
/** Rows a pane needs to show its header and a screen of rows; a shorter terminal shows one stack. */
const NARROW_TIDY_MIN_ROWS = 12;

type Rect = Pick<FloatingPaneEntry, "x" | "y" | "width" | "height">;

export interface FloatingPaneVisibility {
  instanceId: string;
  buried: boolean;
  visibleRatio: number;
  titleBarVisibleRatio: number;
}

function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function subtractRect(rect: Rect, cover: Rect): Rect[] {
  const left = Math.max(rect.x, cover.x);
  const top = Math.max(rect.y, cover.y);
  const right = Math.min(rect.x + rect.width, cover.x + cover.width);
  const bottom = Math.min(rect.y + rect.height, cover.y + cover.height);
  if (left >= right || top >= bottom) return [rect];

  return [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom },
    { x: rect.x, y: top, width: left - rect.x, height: bottom - top },
    { x: right, y: top, width: rect.x + rect.width - right, height: bottom - top },
  ].filter((piece) => piece.width > 0 && piece.height > 0);
}

function visibleRatio(rect: Rect, covers: Rect[]): number {
  const area = rectArea(rect);
  if (area === 0) return 0;
  let pieces = [rect];
  for (const cover of covers) {
    pieces = pieces.flatMap((piece) => subtractRect(piece, cover));
    if (pieces.length === 0) return 0;
  }
  return Math.min(1, pieces.reduce((sum, piece) => sum + rectArea(piece), 0) / area);
}

export function analyzeFloatingPaneVisibility(layout: LayoutConfig): FloatingPaneVisibility[] {
  const frontToBack = layout.floating
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (
      (right.entry.zIndex ?? 50) - (left.entry.zIndex ?? 50)
      || right.index - left.index
    ));
  const covers: Rect[] = [];

  return frontToBack.map(({ entry }) => {
    const paneVisibleRatio = visibleRatio(entry, covers);
    const titleBar = {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: Math.min(entry.height, Math.max(1, entry.height * TITLE_BAR_HEIGHT_RATIO)),
    };
    const titleBarVisibleRatio = visibleRatio(titleBar, covers);
    covers.push(entry);
    return {
      instanceId: entry.instanceId,
      buried: paneVisibleRatio < BURIED_VISIBLE_RATIO || titleBarVisibleRatio < BURIED_VISIBLE_RATIO,
      visibleRatio: paneVisibleRatio,
      titleBarVisibleRatio,
    };
  });
}

export function shouldShowTidyWindows(layout: LayoutConfig): boolean {
  return layout.floating.length >= TIDY_FLOATING_THRESHOLD
    || analyzeFloatingPaneVisibility(layout).some((pane) => pane.buried);
}

function withStacks(node: DockLayoutNode | null, stacks: ReadonlyMap<string, readonly string[]>): DockLayoutNode | null {
  if (!node || stacks.size === 0) return node;
  if (node.kind === "pane") {
    const tabs = stacks.get(node.instanceId);
    return tabs ? buildDockStack(tabs, node.instanceId) : node;
  }
  return { ...node, first: withStacks(node.first, stacks)!, second: withStacks(node.second, stacks)! };
}

/**
 * A narrow terminal's Tidy: every pane at the full width, in one column of
 * at most two stacks, one above the other, each holding its share of the
 * panes as tabs in reading order. A grid of eight panes at 52 columns was
 * eleven-column tiles no table could be read in.
 */
function narrowDockTree(rects: readonly GridlockRect[], stacks: ReadonlyMap<string, readonly string[]>, height: number): DockLayoutNode | null {
  const order = [...rects]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .flatMap((rect) => stacks.get(rect.instanceId) ?? [rect.instanceId]);
  if (order.length <= 1 || height < NARROW_TIDY_MIN_ROWS * 2) return buildDockStack(order);
  const split = Math.ceil(order.length / 2);
  return {
    kind: "split",
    axis: "vertical",
    ratio: 0.5,
    first: buildDockStack(order.slice(0, split))!,
    second: buildDockStack(order.slice(split))!,
  };
}

/**
 * The one column a narrow terminal's Tidy leaves (`narrowDockTree`): one
 * stack, or a stack above another or above a pane, with nothing floating.
 * Tidied on a wider terminal, its panes are tiled in a grid again rather
 * than kept as the two stacks the narrow one needed.
 */
function isNarrowTidyColumn(layout: LayoutConfig): boolean {
  const root = layout.dockRoot;
  if (!root || layout.floating.length > 0) return false;
  if (isDockStack(root)) return true;
  const stackOrPane = (node: DockLayoutNode) => isDockStack(node) || node.kind === "pane";
  return root.kind === "split" && root.axis === "vertical"
    && stackOrPane(root.first) && stackOrPane(root.second) && (isDockStack(root.first) || isDockStack(root.second));
}

export function gridlockAllPanes(
  layout: LayoutConfig,
  bounds: LayoutBounds = { x: 0, y: 0, width: 120, height: 40 },
  paneTypes?: PaneTypeAvailability,
): LayoutConfig {
  const visibleLayout = paneTypes
    ? removeUnavailablePaneTypes(layout, paneTypes)
    : layout;
  const leaves = getDockLeafLayouts(visibleLayout, bounds);
  const dockedRects: GridlockRect[] = leaves.map((leaf) => ({ instanceId: leaf.instanceId, ...leaf.rect }));
  // A stack is tiled as the tab it shows and keeps its other tabs.
  const stacks = new Map(leaves.flatMap((leaf) => (leaf.stack ? [[leaf.instanceId, leaf.stack] as const] : [])));
  const floatingRects: GridlockRect[] = visibleLayout.floating.map((entry) => ({
    instanceId: entry.instanceId,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
  }));
  const allRects = [...dockedRects, ...floatingRects];
  if (allRects.length === 0) return visibleLayout;

  // Decided by the width each time: a column a narrow Tidy left is a grid again on a wider terminal.
  const wideDockTree = () => isNarrowTidyColumn(visibleLayout)
    ? buildGridDockTree(dockedRects.flatMap((rect) => stacks.get(rect.instanceId) ?? [rect.instanceId]))
    : withStacks(inferDockTreeFromRects(allRects, boundsForRects(allRects)), stacks);
  return finalizeLayout({
    ...visibleLayout,
    dockRoot: bounds.width < NARROW_TIDY_WIDTH ? narrowDockTree(allRects, stacks, bounds.height) : wideDockTree(),
    floating: [],
  });
}

/**
 * Tidy Windows, for every surface that offers it: retile `layout` into a
 * `size` viewport and hand the result to `apply`. A layout with no panes to
 * tidy stays put, with no toast. Given `notify`, the user is told, and
 * `onRevert` backs the toast's Revert action.
 */
export function tidyWindows({ layout, size, paneTypes, apply, notify, onRevert }: {
  layout: LayoutConfig;
  size: { width: number; height: number };
  paneTypes?: PaneTypeAvailability;
  apply: (layout: LayoutConfig) => void;
  notify?: (notification: AppNotificationRequest) => void;
  onRevert?: () => void;
}): void {
  const nextLayout = gridlockAllPanes(layout, { x: 0, y: 0, width: size.width, height: size.height }, paneTypes);
  if (nextLayout === layout) return;
  apply(nextLayout);
  notify?.({
    body: "Windows tidied",
    type: "success",
    ...(onRevert ? { action: { label: "Revert", onClick: onRevert } } : {}),
  });
}
