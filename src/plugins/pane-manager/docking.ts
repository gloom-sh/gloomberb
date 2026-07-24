import type { LayoutConfig, PaneInstanceConfig } from "../../types/config";
import { findPaneInstance } from "../../types/config";
import {
  buildSplitAroundNode,
  clampRatio,
  findDockLeaf,
  getNodeAtPath,
  replaceNodeAtPath,
  type DockGeometryOptions,
  type DockTarget,
  type LayoutBounds,
} from "./dock-tree";
import type { DropTarget, LeafDropPosition, LayoutSimulation } from "./types";
import { getLeafRect } from "./queries";
import { detachPane, ensurePaneInstance, finalizeLayout } from "./layout-state";

function insertRelativeToSubtreePath(
  layout: LayoutConfig,
  instanceId: string,
  targetPath: Array<0 | 1>,
  position: DockTarget["position"],
): LayoutConfig {
  const base = detachPane(layout, instanceId);
  if (!base.dockRoot) {
    return finalizeLayout({ ...base, dockRoot: { kind: "pane", instanceId } });
  }

  let candidatePath = [...targetPath];
  let targetNode = getNodeAtPath(base.dockRoot, candidatePath);
  while (!targetNode && candidatePath.length > 0) {
    candidatePath = candidatePath.slice(0, -1);
    targetNode = getNodeAtPath(base.dockRoot, candidatePath);
  }

  if (!targetNode) {
    return finalizeLayout({
      ...base,
      dockRoot: buildSplitAroundNode(base.dockRoot, instanceId, position),
    });
  }

  const replacement = buildSplitAroundNode(targetNode, instanceId, position);
  return finalizeLayout({
    ...base,
    dockRoot: replaceNodeAtPath(base.dockRoot, candidatePath, replacement),
  });
}

function normalizeDropPosition(position: LeafDropPosition): "left" | "right" | "top" | "bottom" | "center" {
  switch (position) {
    case "top-left":
    case "top-right":
      return "top";
    case "bottom-left":
    case "bottom-right":
      return "bottom";
    default:
      return position;
  }
}

function insertRelativeToLeaf(layout: LayoutConfig, instanceId: string, targetId: string, position: DockTarget["position"]): LayoutConfig {
  if (instanceId === targetId) return layout;
  const base = detachPane(layout, instanceId);
  const targetLeaf = findDockLeaf(base, targetId);
  if (!targetLeaf || !base.dockRoot) return layout;
  const targetNode = getNodeAtPath(base.dockRoot, targetLeaf.path);
  if (!targetNode) return layout;
  return finalizeLayout({
    ...base,
    dockRoot: replaceNodeAtPath(base.dockRoot, targetLeaf.path, buildSplitAroundNode(targetNode, instanceId, position)),
  });
}

export function insertAtRootEdge(layout: LayoutConfig, instanceId: string, edge: "left" | "right" | "top" | "bottom"): LayoutConfig {
  const base = detachPane(layout, instanceId);
  if (!base.dockRoot) {
    return finalizeLayout({ ...base, dockRoot: { kind: "pane", instanceId } });
  }
  return finalizeLayout({
    ...base,
    dockRoot: buildSplitAroundNode(base.dockRoot, instanceId, edge === "top" ? "above" : edge === "bottom" ? "below" : edge),
  });
}

function dockAtTarget(layout: LayoutConfig, instanceId: string, target: DockTarget): LayoutConfig {
  return insertRelativeToLeaf(layout, instanceId, target.relativeTo, target.position);
}

export function dockPane(layout: LayoutConfig, instanceId: string, target?: DockTarget): LayoutConfig {
  if (target) return dockAtTarget(layout, instanceId, target);

  const instance = findPaneInstance(layout, instanceId);
  const dockedMemory = instance?.placementMemory?.docked;
  if (dockedMemory?.position && dockedMemory.path && dockedMemory.path.length > 0) {
    return insertRelativeToSubtreePath(layout, instanceId, dockedMemory.path.slice(0, -1), dockedMemory.position);
  }
  if (dockedMemory?.anchorInstanceId && dockedMemory.position && findDockLeaf(layout, dockedMemory.anchorInstanceId)) {
    return insertRelativeToLeaf(layout, instanceId, dockedMemory.anchorInstanceId, dockedMemory.position);
  }
  if (!layout.dockRoot) {
    return finalizeLayout({ ...detachPane(layout, instanceId), dockRoot: { kind: "pane", instanceId } });
  }
  return insertAtRootEdge(layout, instanceId, "right");
}

export function applyDrop(layout: LayoutConfig, draggedId: string, dropTarget: DropTarget): LayoutConfig {
  if (dropTarget.kind === "frame") {
    return insertAtRootEdge(layout, draggedId, dropTarget.edge);
  }

  const normalized = normalizeDropPosition(dropTarget.position);
  if (normalized === "center") {
    return swapPanes(layout, draggedId, dropTarget.targetId);
  }
  const direction = normalized === "top" ? "above" : normalized === "bottom" ? "below" : normalized;
  return insertRelativeToLeaf(layout, draggedId, dropTarget.targetId, direction);
}

export function simulateDrop(
  layout: LayoutConfig,
  draggedId: string,
  dropTarget: DropTarget,
  bounds: LayoutBounds,
  options?: DockGeometryOptions,
): LayoutSimulation {
  const nextLayout = applyDrop(layout, draggedId, dropTarget);
  return {
    layout: nextLayout,
    previewRect: getLeafRect(nextLayout, draggedId, bounds, options),
  };
}

export function swapPanes(layout: LayoutConfig, firstId: string, secondId: string): LayoutConfig {
  if (firstId === secondId) return layout;
  const firstLeaf = findDockLeaf(layout, firstId);
  const secondLeaf = findDockLeaf(layout, secondId);
  const firstFloating = layout.floating.find((entry) => entry.instanceId === firstId);
  const secondFloating = layout.floating.find((entry) => entry.instanceId === secondId);
  if (!firstLeaf && !firstFloating) return layout;
  if (!secondLeaf && !secondFloating) return layout;

  if (firstLeaf && secondLeaf && layout.dockRoot) {
    const firstNode = getNodeAtPath(layout.dockRoot, firstLeaf.path);
    const secondNode = getNodeAtPath(layout.dockRoot, secondLeaf.path);
    if (!firstNode || !secondNode || firstNode.kind !== "pane" || secondNode.kind !== "pane") return layout;
    const withFirst = replaceNodeAtPath(layout.dockRoot, firstLeaf.path, { kind: "pane", instanceId: secondId });
    const withSecond = replaceNodeAtPath(withFirst, secondLeaf.path, { kind: "pane", instanceId: firstId });
    return finalizeLayout({ ...layout, dockRoot: withSecond });
  }

  if (firstFloating && secondFloating) {
    return finalizeLayout({
      ...layout,
      floating: layout.floating.map((entry) => {
        if (entry.instanceId === firstId) return { ...secondFloating, instanceId: firstId };
        if (entry.instanceId === secondId) return { ...firstFloating, instanceId: secondId };
        return entry;
      }),
    });
  }

  const dockedId = firstLeaf ? firstId : secondId;
  const floatingId = firstFloating ? firstId : secondId;
  const dockedLeaf = firstLeaf ?? secondLeaf!;
  const floatingEntry = firstFloating ?? secondFloating!;
  const base = layout.dockRoot && dockedLeaf
    ? replaceNodeAtPath(layout.dockRoot, dockedLeaf.path, { kind: "pane", instanceId: floatingId })
    : layout.dockRoot;

  return finalizeLayout({
    ...layout,
    dockRoot: base,
    floating: [
      ...layout.floating.filter((entry) => entry.instanceId !== floatingId),
      {
        instanceId: dockedId,
        x: floatingEntry.x,
        y: floatingEntry.y,
        width: floatingEntry.width,
        height: floatingEntry.height,
        zIndex: floatingEntry.zIndex,
        fixedGeometry: floatingEntry.fixedGeometry,
      },
    ],
  });
}

export function resizeSplitAtPath(layout: LayoutConfig, path: Array<0 | 1>, ratio: number): LayoutConfig {
  const target = getNodeAtPath(layout.dockRoot, path);
  if (!target || target.kind !== "split" || !layout.dockRoot) return layout;
  return finalizeLayout({
    ...layout,
    dockRoot: replaceNodeAtPath(layout.dockRoot, path, {
      ...target,
      ratio: clampRatio(ratio),
    }),
  });
}

export function addPaneToLayout(layout: LayoutConfig, instance: PaneInstanceConfig, target: DockTarget): LayoutConfig {
  const withInstance = ensurePaneInstance(layout, instance);
  if (!withInstance.dockRoot) {
    return finalizeLayout({
      ...withInstance,
      dockRoot: { kind: "pane", instanceId: instance.instanceId },
    });
  }
  return dockAtTarget(withInstance, instance.instanceId, target);
}
