import {
  findPaneInstance,
  getPlacedPaneInstanceIds,
  isTickerPaneId,
  TICKER_RESEARCH_PANE_ID,
  type AppConfig,
  type DockedPlacementMemory,
  type FloatingPlacementMemory,
  type LayoutConfig,
  type PaneInstanceConfig,
  type PaneMovedFrom,
  type PaneMovedLink,
} from "../types/config";
import { pinFollowingPane } from "./pane-follow";
import { findDockLeaf, getNodeAtPath, getRepresentativeLeafId } from "./pane-manager/dock-tree";
import { dockPane, insertAtRootEdge, resizeSplitAtPath } from "./pane-manager/docking";
import { floatAtRect } from "./pane-manager/floating-actions";
import { finalizeLayout, removePane } from "./pane-manager/layout-state";

let nextSavedLayoutSeq = 0;

/** A fresh `SavedLayout.id`, unique across devices that sync the same layouts. */
export function createSavedLayoutId(): string {
  nextSavedLayoutSeq += 1;
  return `layout:${Date.now().toString(36)}${nextSavedLayoutSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The ticker a pane shows right now, through its links; null when it shows none. */
type ResolvePaneSymbol = (instanceId: string) => string | null;

/** Why a pane cannot leave for a layout of its own. */
export type PaneNewLayoutBlock =
  | "missing"
  /** It sits in its own desktop window already. */
  | "detached"
  /** A layout of one pane already is one. */
  | "only-pane"
  /** It follows a list with nothing selected, and a ticker pane with no ticker closes. */
  | "no-ticker";

export function paneNewLayoutBlock(
  layout: LayoutConfig,
  paneId: string,
  resolveSymbol: ResolvePaneSymbol,
): PaneNewLayoutBlock | null {
  const instance = findPaneInstance(layout, paneId);
  const placed = getPlacedPaneInstanceIds(layout);
  if (!instance || !placed.includes(paneId)) return "missing";
  if ((layout.detached ?? []).some((entry) => entry.instanceId === paneId)) return "detached";
  if (placed.length <= 1) return "only-pane";
  if (
    instance.binding?.kind === "follow"
    && isTickerPaneId(instance.paneId)
    && instance.paneId !== TICKER_RESEARCH_PANE_ID
    && !resolveSymbol(paneId)?.trim()
  ) return "no-ticker";
  return null;
}

function movedLink(before: PaneInstanceConfig, after: PaneInstanceConfig, symbol: string): PaneMovedLink {
  return {
    instanceId: before.instanceId,
    sourceInstanceId: before.binding?.kind === "follow" ? before.binding.sourceInstanceId : "",
    symbol,
    ...(before.title !== undefined && after.title !== before.title ? { title: before.title } : {}),
  };
}

/**
 * Pins every pane whose link source is gone on the ticker it showed, the way
 * closing that source does, and says which links were cut.
 */
function pinOrphanedFollowers(
  layout: LayoutConfig,
  resolveSymbol: ResolvePaneSymbol,
): { layout: LayoutConfig; links: PaneMovedLink[] } {
  const ids = new Set(layout.instances.map((instance) => instance.instanceId));
  const links: PaneMovedLink[] = [];
  let changed = false;
  const instances = layout.instances.map((instance) => {
    if (instance.binding?.kind !== "follow" || ids.has(instance.binding.sourceInstanceId)) return instance;
    changed = true;
    const symbol = resolveSymbol(instance.instanceId)?.trim() || null;
    const pinned = pinFollowingPane(instance, symbol);
    if (symbol) links.push(movedLink(instance, pinned, symbol));
    return pinned;
  });
  return { layout: changed ? finalizeLayout({ ...layout, instances }) : layout, links };
}

/** Where a docked pane sits: its path, the neighbour it splits with, and its share of the split. */
function dockedPlacement(layout: LayoutConfig, paneId: string): PaneMovedFrom["docked"] {
  const leaf = findDockLeaf(layout, paneId);
  if (!leaf) return { path: [] };
  if (leaf.path.length === 0) return { path: [] };
  const parent = getNodeAtPath(layout.dockRoot, leaf.path.slice(0, -1));
  if (!parent || parent.kind !== "split") return { path: [...leaf.path] };
  const branch = leaf.path[leaf.path.length - 1]!;
  const sibling = branch === 0 ? parent.second : parent.first;
  return {
    path: [...leaf.path],
    anchorInstanceId: getRepresentativeLeafId(sibling, branch === 0),
    position: parent.axis === "horizontal"
      ? (branch === 0 ? "left" : "right")
      : (branch === 0 ? "above" : "below"),
    ratio: parent.ratio,
  };
}

export interface PaneLayoutMove {
  /** The layout the pane left: the dock tree closed over the gap, its followers pinned. */
  source: LayoutConfig;
  /** The layout the pane landed in. */
  target: LayoutConfig;
}

/**
 * Takes a pane out of `layout` into a layout of its own, docked alone so it
 * fills the window. The instance keeps its id, settings and lock, and records
 * where it came from so Move Back can return it. Null when the pane cannot go.
 */
export function movePaneToOwnLayout(
  layout: LayoutConfig,
  paneId: string,
  sourceLayoutId: string,
  resolveSymbol: ResolvePaneSymbol,
): PaneLayoutMove | null {
  if (paneNewLayoutBlock(layout, paneId, resolveSymbol)) return null;
  const instance = findPaneInstance(layout, paneId)!;
  const floatingEntry = layout.floating.find((entry) => entry.instanceId === paneId);
  const floating: FloatingPlacementMemory | undefined = floatingEntry
    ? { x: floatingEntry.x, y: floatingEntry.y, width: floatingEntry.width, height: floatingEntry.height }
    : undefined;
  const left = pinOrphanedFollowers(removePane(layout, paneId), resolveSymbol);

  // Alone in its layout the pane has nothing to follow, so it keeps the ticker it shows.
  let moved: PaneInstanceConfig = instance;
  const links: PaneMovedLink[] = [];
  if (instance.binding?.kind === "follow") {
    const symbol = resolveSymbol(paneId)?.trim() || null;
    moved = pinFollowingPane(instance, symbol);
    if (symbol) links.push(movedLink(instance, moved, symbol));
  }
  links.push(...left.links);
  const movedFrom: PaneMovedFrom = {
    layoutId: sourceLayoutId,
    ...(floating ? { floating } : { docked: dockedPlacement(layout, paneId) }),
    ...(links.length > 0 ? { links } : {}),
  };
  return {
    source: left.layout,
    target: finalizeLayout({
      dockRoot: { kind: "pane", instanceId: paneId },
      instances: [{ ...moved, movedFrom }],
      floating: [],
      detached: [],
    }),
  };
}

export interface PaneMoveBackTarget {
  /** Index in `config.layouts`. */
  index: number;
  name: string;
  /** The layout the pane came from; false when that one is gone and this is the first other tab. */
  original: boolean;
}

/** Where Move Back takes a pane of the active layout, or null when it has nowhere to go. */
export function paneMoveBackTarget(
  config: Pick<AppConfig, "layout" | "layouts" | "activeLayoutIndex">,
  paneId: string,
): PaneMoveBackTarget | null {
  const movedFrom = findPaneInstance(config.layout, paneId)?.movedFrom;
  if (!movedFrom) return null;
  if ((config.layout.detached ?? []).some((entry) => entry.instanceId === paneId)) return null;
  const others = config.layouts.flatMap((entry, index) => (index === config.activeLayoutIndex ? [] : [{ entry, index }]));
  const original = others.find(({ entry }) => entry.id === movedFrom.layoutId);
  const target = original ?? others[0];
  return target ? { index: target.index, name: target.entry.name, original: !!original } : null;
}

function withDockedMemory(layout: LayoutConfig, paneId: string, docked: DockedPlacementMemory): LayoutConfig {
  return {
    ...layout,
    instances: layout.instances.map((instance) => (
      instance.instanceId === paneId
        ? { ...instance, placementMemory: { ...instance.placementMemory, docked } }
        : instance
    )),
  };
}

/** The split the pane came back into takes the share it had, when the pane landed where it was. */
function restoreSplitRatio(layout: LayoutConfig, paneId: string, path: Array<0 | 1> | undefined, ratio: number | undefined): LayoutConfig {
  if (ratio === undefined || !path || path.length === 0) return layout;
  const leaf = findDockLeaf(layout, paneId);
  if (!leaf || leaf.path.join(".") !== path.join(".")) return layout;
  return resizeSplitAtPath(layout, path.slice(0, -1), ratio);
}

function followsInto(layout: LayoutConfig, fromId: string, targetId: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = fromId;
  while (current && !seen.has(current)) {
    if (current === targetId) return true;
    seen.add(current);
    const binding: PaneInstanceConfig["binding"] = findPaneInstance(layout, current)?.binding;
    current = binding?.kind === "follow" ? binding.sourceInstanceId : undefined;
  }
  return false;
}

/** Links again the panes the move pinned, while each still shows the ticker it was pinned on. */
function relink(layout: LayoutConfig, links: readonly PaneMovedLink[]): LayoutConfig {
  let next = layout;
  for (const link of links) {
    const instance = findPaneInstance(next, link.instanceId);
    if (!instance || instance.binding?.kind !== "fixed" || instance.binding.symbol !== link.symbol) continue;
    if (!findPaneInstance(next, link.sourceInstanceId) || followsInto(next, link.sourceInstanceId, link.instanceId)) continue;
    next = {
      ...next,
      instances: next.instances.map((entry) => (
        entry.instanceId === link.instanceId
          ? { ...entry, binding: { kind: "follow", sourceInstanceId: link.sourceInstanceId }, ...("title" in link ? { title: link.title } : {}) }
          : entry
      )),
    };
  }
  return next === layout ? layout : finalizeLayout(next);
}

/**
 * Takes a pane Move to New Layout moved out of `layout` and puts it back in
 * `target`: where it was when `original`, otherwise docked on the right. Links
 * the move cut are restored when the panes they joined are both there again.
 */
export function movePaneBack(
  layout: LayoutConfig,
  target: LayoutConfig,
  paneId: string,
  original: boolean,
  resolveSymbol: ResolvePaneSymbol,
): PaneLayoutMove | null {
  const instance = findPaneInstance(layout, paneId);
  const movedFrom = instance?.movedFrom;
  if (!instance || !movedFrom) return null;
  const left = pinOrphanedFollowers(removePane(layout, paneId), resolveSymbol).layout;
  const { movedFrom: _movedFrom, ...returning } = instance;
  // A copy an undo put back in the target gives way to the pane coming home.
  const base = findPaneInstance(target, paneId) ? removePane(target, paneId) : target;
  const withPane: LayoutConfig = { ...base, instances: [...base.instances, returning] };

  let placed: LayoutConfig;
  if (original && movedFrom.floating) {
    placed = floatAtRect(withPane, paneId, movedFrom.floating);
  } else if (original && movedFrom.docked) {
    const { ratio, ...docked } = movedFrom.docked;
    placed = restoreSplitRatio(dockPane(withDockedMemory(withPane, paneId, docked), paneId), paneId, docked.path, ratio);
  } else {
    placed = insertAtRootEdge(withPane, paneId, "right");
  }
  return { source: left, target: original ? relink(placed, movedFrom.links ?? []) : placed };
}
