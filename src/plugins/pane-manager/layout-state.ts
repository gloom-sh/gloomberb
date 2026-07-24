import type {
  DockLayoutNode,
  DockedPlacementMemory,
  FloatingPaneEntry,
  LayoutConfig,
  PaneInstanceConfig,
} from "../../types/config";
import {
  clonePlacementMemory,
  normalizePaneLayout,
  removePaneInstances,
} from "../../types/config";
import {
  collectDockLeafRefs,
  getDockedInstanceIds,
  getNodeAtPath,
  getRepresentativeLeafId,
  removeNodeAtPath,
} from "./dock-tree";

export function ensurePaneInstance(layout: LayoutConfig, instance: PaneInstanceConfig): LayoutConfig {
  if (layout.instances.some((entry) => entry.instanceId === instance.instanceId)) return layout;
  return { ...layout, instances: [...layout.instances, instance] };
}

function normalizeFloatingEntries(layout: LayoutConfig): FloatingPaneEntry[] {
  const dockedIds = new Set(getDockedInstanceIds(layout.dockRoot));
  const detachedIds = new Set((layout.detached ?? []).map((entry) => entry.instanceId));
  const seen = new Set<string>();
  return layout.floating
    .filter((entry) => !dockedIds.has(entry.instanceId) && !detachedIds.has(entry.instanceId))
    .filter((entry) => {
      if (seen.has(entry.instanceId)) return false;
      seen.add(entry.instanceId);
      return true;
    })
    .map((entry) => ({ ...entry }));
}

function normalizeDetachedEntries(layout: LayoutConfig) {
  const dockedIds = new Set(getDockedInstanceIds(layout.dockRoot));
  const floatingIds = new Set(layout.floating.map((entry) => entry.instanceId));
  const seen = new Set<string>();
  return (layout.detached ?? [])
    .filter((entry) => !dockedIds.has(entry.instanceId) && !floatingIds.has(entry.instanceId))
    .filter((entry) => {
      if (seen.has(entry.instanceId)) return false;
      seen.add(entry.instanceId);
      return true;
    })
    .map((entry) => ({ ...entry }));
}

function captureDockedMemory(dockRoot: DockLayoutNode | null): Map<string, DockedPlacementMemory> {
  const memory = new Map<string, DockedPlacementMemory>();
  const leaves = collectDockLeafRefs(dockRoot);

  for (const leaf of leaves) {
    if (leaf.path.length === 0) {
      memory.set(leaf.instanceId, { path: [] });
      continue;
    }

    const parentPath = leaf.path.slice(0, -1);
    const branch = leaf.path[leaf.path.length - 1]!;
    const parent = getNodeAtPath(dockRoot, parentPath);
    if (!parent || parent.kind !== "split") {
      memory.set(leaf.instanceId, { path: [...leaf.path] });
      continue;
    }

    const sibling = branch === 0 ? parent.second : parent.first;
    const position = parent.axis === "horizontal"
      ? (branch === 0 ? "left" : "right")
      : (branch === 0 ? "above" : "below");

    memory.set(leaf.instanceId, {
      path: [...leaf.path],
      anchorInstanceId: getRepresentativeLeafId(sibling, branch === 0),
      position,
    });
  }

  return memory;
}

function capturePlacementMemory(layout: LayoutConfig): LayoutConfig {
  const dockedMemory = captureDockedMemory(layout.dockRoot);
  const floatingById = new Map(layout.floating.map((entry) => [entry.instanceId, entry] as const));
  const detachedById = new Map((layout.detached ?? []).map((entry) => [entry.instanceId, entry] as const));

  return {
    ...layout,
    instances: layout.instances.map((instance) => {
      const previous = clonePlacementMemory(instance.placementMemory) ?? {};
      const nextDocked = dockedMemory.get(instance.instanceId) ?? previous.docked;
      const floating = floatingById.get(instance.instanceId);
      const nextFloating = floating ? {
        x: floating.x,
        y: floating.y,
        width: floating.width,
        height: floating.height,
        fixedGeometry: floating.fixedGeometry,
      } : previous.floating;
      const detached = detachedById.get(instance.instanceId);
      const nextDetached = detached ? {
        x: detached.x,
        y: detached.y,
        width: detached.width,
        height: detached.height,
      } : previous.detached;

      return {
        ...instance,
        placementMemory: nextDocked || nextFloating || nextDetached ? {
          docked: nextDocked,
          floating: nextFloating,
          detached: nextDetached,
        } : undefined,
      };
    }),
  };
}

export function finalizeLayout(layout: LayoutConfig): LayoutConfig {
  const normalized = normalizePaneLayout({
    ...layout,
    floating: normalizeFloatingEntries(layout),
    detached: normalizeDetachedEntries(layout),
  });
  return capturePlacementMemory(normalized);
}

function removeDockedLeaf(layout: LayoutConfig, instanceId: string): LayoutConfig {
  const leaf = collectDockLeafRefs(layout.dockRoot).find((entry) => entry.instanceId === instanceId);
  if (!leaf) return layout;
  return {
    ...layout,
    dockRoot: removeNodeAtPath(layout.dockRoot, leaf.path),
  };
}

export function detachPane(layout: LayoutConfig, instanceId: string): LayoutConfig {
  return {
    ...removeDockedLeaf(layout, instanceId),
    floating: layout.floating.filter((entry) => entry.instanceId !== instanceId),
    detached: (layout.detached ?? []).filter((entry) => entry.instanceId !== instanceId),
  };
}

export function removePane(layout: LayoutConfig, instanceId: string): LayoutConfig {
  return finalizeLayout(removePaneInstances(
    {
      ...layout,
      dockRoot: removeDockedLeaf(layout, instanceId).dockRoot,
      floating: layout.floating.filter((entry) => entry.instanceId !== instanceId),
      detached: (layout.detached ?? []).filter((entry) => entry.instanceId !== instanceId),
    },
    [instanceId],
  ));
}

export function removeFloatingPanes(layout: LayoutConfig): LayoutConfig {
  if (layout.floating.length === 0) return layout;
  return finalizeLayout(removePaneInstances(
    {
      ...layout,
      floating: [],
    },
    layout.floating.map((entry) => entry.instanceId),
  ));
}

export type PaneTypeAvailability = { has(paneId: string): boolean } | ((paneId: string) => unknown);

function paneTypeIsAvailable(availability: PaneTypeAvailability, paneId: string): boolean {
  return typeof availability === "function"
    ? !!availability(paneId)
    : availability.has(paneId);
}

export function removeUnavailablePaneTypes(
  layout: LayoutConfig,
  availability: PaneTypeAvailability,
  options: { disabledPaneIds?: ReadonlySet<string> } = {},
): LayoutConfig {
  const unavailableInstanceIds = layout.instances
    .filter((instance) => (
      options.disabledPaneIds?.has(instance.paneId)
      || !paneTypeIsAvailable(availability, instance.paneId)
    ))
    .map((instance) => instance.instanceId);

  return unavailableInstanceIds.length > 0
    ? removePaneInstances(layout, unavailableInstanceIds)
    : layout;
}
