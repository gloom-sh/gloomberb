import type {
  FloatingPaneEntry,
  LayoutConfig,
  PaneInstanceConfig,
} from "../../types/config";
import type { PaneDef } from "../../types/plugin";
import { findPaneInstance } from "../../types/config";
import { missingPanePlaceholderDef } from "../../components/layout/missing-pane";
import {
  collectDockLeafRefs,
  countColumnsFromGeometry,
  findDockLeaf,
  getDockLeafLayouts,
  type DockGeometryOptions,
  type LayoutBounds,
} from "./dock-tree";

export interface ResolvedPane {
  instance: PaneInstanceConfig;
  def: PaneDef;
  floating?: FloatingPaneEntry;
  path?: Array<0 | 1>;
}

export function getLeafRect(
  layout: LayoutConfig,
  instanceId: string,
  bounds: LayoutBounds,
  options?: DockGeometryOptions,
): LayoutBounds | null {
  return getDockLeafLayouts(layout, bounds, options).find((entry) => entry.instanceId === instanceId)?.rect ?? null;
}

export function resolveDocked(
  layout: LayoutConfig,
  registeredPanes: ReadonlyMap<string, PaneDef>,
): ResolvedPane[] {
  const result: ResolvedPane[] = [];
  for (const leaf of collectDockLeafRefs(layout.dockRoot)) {
    const instance = findPaneInstance(layout, leaf.instanceId);
    if (!instance) continue;
    // A pane from a plugin this terminal lacks keeps its slot and its config,
    // rendered as a placeholder, so a teammate's pane is never dropped.
    const def = registeredPanes.get(instance.paneId) ?? missingPanePlaceholderDef(instance.paneId);
    result.push({ instance, def, path: leaf.path });
  }
  return result;
}

export function resolveFloating(
  layout: LayoutConfig,
  registeredPanes: ReadonlyMap<string, PaneDef>,
): ResolvedPane[] {
  const result: ResolvedPane[] = [];
  for (const entry of layout.floating) {
    const instance = findPaneInstance(layout, entry.instanceId);
    if (!instance) continue;
    const def = registeredPanes.get(instance.paneId) ?? missingPanePlaceholderDef(instance.paneId);
    result.push({ instance, def, floating: entry });
  }
  result.sort((a, b) => (a.floating?.zIndex ?? 50) - (b.floating?.zIndex ?? 50));
  return result;
}

export function isPaneInLayout(layout: LayoutConfig, instanceId: string): boolean {
  return !!findDockLeaf(layout, instanceId)
    || layout.floating.some((entry) => entry.instanceId === instanceId)
    || (layout.detached ?? []).some((entry) => entry.instanceId === instanceId);
}

export function isPaneDetached(layout: LayoutConfig, instanceId: string): boolean {
  return (layout.detached ?? []).some((entry) => entry.instanceId === instanceId);
}

export function isPaneDocked(layout: LayoutConfig, instanceId: string): boolean {
  return !!findDockLeaf(layout, instanceId);
}

export function getLayoutPreview(layout: LayoutConfig): string {
  const geometry = getDockLeafLayouts(layout, { x: 0, y: 0, width: 120, height: 40 });
  return `${countColumnsFromGeometry(geometry)}c / ${geometry.length}d / ${layout.floating.length}f / ${(layout.detached ?? []).length}x`;
}
