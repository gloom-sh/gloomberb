import {
  getDockLeafLayouts,
  type DockTarget,
} from "../../layout/pane-manager";
import {
  findPaneInstance,
  isTickerPaneId,
  normalizePaneId,
  resolvePaneInstance,
  type AppConfig,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../../types/config";

const PANEL_RESOLUTION_BOUNDS = { x: 0, y: 0, width: 120, height: 40 };

export function isCollectionPaneInstance(instance: PaneInstanceConfig): boolean {
  return instance.paneId === "portfolio-list";
}

export function isTickerContextPaneInstance(instance: PaneInstanceConfig): boolean {
  return instance.paneId === "portfolio-list" || isTickerPaneId(instance.paneId);
}

export function resolvePaneTarget(layout: LayoutConfig, paneId: string): string | null {
  return resolvePaneInstance(layout, normalizePaneId(paneId))?.instanceId
    ?? resolvePaneInstance(layout, paneId)?.instanceId
    ?? null;
}

/** Resolve an instance id before looking up its registered pane type. */
export function resolvePaneShowTarget(
  layout: LayoutConfig,
  paneId: string,
): { paneType: string; instance: PaneInstanceConfig | null } {
  const instanceId = resolvePaneTarget(layout, paneId);
  const instance = instanceId ? findPaneInstance(layout, instanceId) ?? null : null;
  return {
    paneType: normalizePaneId(instance?.paneId ?? paneId),
    instance,
  };
}

export function selectEdgeAnchor(layout: LayoutConfig, edge: "left" | "right"): string | null {
  const leaves = getDockLeafLayouts(layout, PANEL_RESOLUTION_BOUNDS);
  if (leaves.length === 0) return null;
  const edgeCoordinate = edge === "left"
    ? Math.min(...leaves.map((leaf) => leaf.rect.x))
    : Math.max(...leaves.map((leaf) => leaf.rect.x + leaf.rect.width));
  return [...leaves]
    .filter((leaf) => (
      edge === "left"
        ? leaf.rect.x === edgeCoordinate
        : leaf.rect.x + leaf.rect.width === edgeCoordinate
    ))
    .sort((a, b) => (b.rect.y + b.rect.height) - (a.rect.y + a.rect.height))
    [0]?.instanceId ?? null;
}

/** A layout with no pane at all, docked, floating or in a window of its own: one a new pane starts a grid in. */
function isEmptyLayout(layout: LayoutConfig): boolean {
  return layout.instances.length === 0 && layout.floating.length === 0 && layout.detached.length === 0 && layout.dockRoot == null;
}

/**
 * Where a pane docks in a layout being built as a grid: beside the largest
 * pane, splitting it along its longer side (a cell is about twice as tall as
 * it is wide), so each pane added halves the roomiest one and four make two
 * by two rather than ever thinner columns. Null with nothing docked.
 */
function gridAnchor(layout: LayoutConfig, bounds: { width: number; height: number }): DockTarget | null {
  const leaves = getDockLeafLayouts(layout, { x: 0, y: 0, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
  const largest = [...leaves].sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height
    || a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0];
  if (!largest) return null;
  return { relativeTo: largest.instanceId, position: largest.rect.width >= largest.rect.height * 2 ? "right" : "below" };
}

/**
 * Where a new pane that would open floating docks instead, in a layout this
 * window has been filling from empty (`grids`, the layouts' keys, which this
 * adds to): beside the roomiest pane (gridAnchor), the first one alone. Four
 * panes added one after another make a grid, not a stack of windows over an
 * empty layout that only Tidy Windows would dock. Null for any other layout,
 * and once the layout has a floating window, which a pane then joins as before.
 */
export function gridDockTarget(
  grids: Set<string>,
  config: Pick<AppConfig, "layout" | "layouts" | "activeLayoutIndex">,
  instanceId: string,
  bounds: { width: number; height: number },
): DockTarget | null {
  const active = config.layouts[config.activeLayoutIndex];
  const key = active ? active.id ?? `${config.activeLayoutIndex}:${active.name}` : null;
  if (!key) return null;
  if (isEmptyLayout(config.layout)) grids.add(key);
  if (!grids.has(key) || config.layout.floating.length > 0) return null;
  return gridAnchor(config.layout, bounds) ?? { relativeTo: instanceId, position: "right" };
}
