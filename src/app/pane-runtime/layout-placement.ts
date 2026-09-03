import type { PluginRegistry } from "../../plugins/registry";
import {
  getDockLeafLayouts,
  getLeafRect,
} from "../../plugins/pane-manager";
import {
  findPaneInstance,
  isTickerPaneId,
  normalizePaneId,
  resolvePaneInstance,
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

export function resolvePanelForPane({
  layout,
  paneId,
  pluginRegistry,
}: {
  layout: LayoutConfig;
  paneId: string;
  pluginRegistry: PluginRegistry;
}): "left" | "right" {
  const instanceId = resolvePaneTarget(layout, paneId);
  if (!instanceId) return "right";
  const instance = findPaneInstance(layout, instanceId);
  const paneDef = instance ? pluginRegistry.panes.get(instance.paneId) : pluginRegistry.panes.get(paneId);
  const floating = layout.floating.find((entry) => entry.instanceId === instanceId);
  if (floating) {
    return paneDef?.defaultPosition ?? "right";
  }

  const rect = getLeafRect(layout, instanceId, PANEL_RESOLUTION_BOUNDS);
  if (!rect) {
    return paneDef?.defaultPosition ?? "right";
  }

  const midpoint = PANEL_RESOLUTION_BOUNDS.width / 2;
  return rect.x + (rect.width / 2) <= midpoint ? "left" : "right";
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
