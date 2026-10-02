import type {
  FloatingPlacementMemory,
  LayoutConfig,
  PaneInstanceConfig,
} from "../../types/config";
import type { PaneDef } from "../../types/plugin";
import { createPaneInstance, findPaneInstance } from "../../types/config";
import {
  clampFloatingRect,
  clampFloatingRectWithinBounds,
  defaultFloatingRect,
  maxFloatingZ,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  updateFloatingPane,
  type FloatingRect,
} from "./floating";
import type { LayoutBounds } from "./dock-tree";
import type { FloatingResizeCorner } from "./types";
import { detachPane, ensurePaneInstance, finalizeLayout } from "./layout-state";

export function detachPaneToFrame(
  layout: LayoutConfig,
  instanceId: string,
  rect: Pick<LayoutConfig["detached"][number], "x" | "y" | "width" | "height">,
): LayoutConfig {
  const base = detachPane(layout, instanceId);
  return finalizeLayout({
    ...base,
    detached: [
      ...base.detached.filter((entry) => entry.instanceId !== instanceId),
      {
        instanceId,
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      },
    ],
  });
}

export function floatAtRect(layout: LayoutConfig, instanceId: string, rect: FloatingRect): LayoutConfig {
  const base = detachPane(layout, instanceId);
  return finalizeLayout({
    ...base,
    floating: [
      ...base.floating.filter((entry) => entry.instanceId !== instanceId),
      {
        instanceId,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: rect.zIndex ?? maxFloatingZ(layout) + 1,
      },
    ],
  });
}

export function moveFloatingPane(
  layout: LayoutConfig,
  instanceId: string,
  deltaX: number,
  deltaY: number,
  bounds: LayoutBounds,
): LayoutConfig {
  const floating = layout.floating.find((entry) => entry.instanceId === instanceId);
  if (!floating) return layout;
  const rect = clampFloatingRectWithinBounds({
    ...floating,
    x: floating.x + deltaX,
    y: floating.y + deltaY,
  }, bounds);
  return finalizeLayout(updateFloatingPane(layout, instanceId, rect));
}

export function resizeFloatingPaneFromCorner(
  layout: LayoutConfig,
  instanceId: string,
  corner: FloatingResizeCorner,
  deltaX: number,
  deltaY: number,
  bounds: LayoutBounds,
): LayoutConfig {
  const floating = layout.floating.find((entry) => entry.instanceId === instanceId);
  if (!floating) return layout;

  let left = floating.x;
  let top = floating.y;
  let right = floating.x + floating.width;
  let bottom = floating.y + floating.height;

  if (corner === "top-left" || corner === "bottom-left") {
    left = Math.max(bounds.x, Math.min(left + deltaX, right - MIN_FLOAT_WIDTH));
  } else {
    right = Math.min(bounds.x + bounds.width, Math.max(right + deltaX, left + MIN_FLOAT_WIDTH));
  }

  if (corner === "top-left" || corner === "top-right") {
    top = Math.max(bounds.y, Math.min(top + deltaY, bottom - MIN_FLOAT_HEIGHT));
  } else {
    bottom = Math.min(bounds.y + bounds.height, Math.max(bottom + deltaY, top + MIN_FLOAT_HEIGHT));
  }

  return finalizeLayout(updateFloatingPane(layout, instanceId, {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }));
}

export function floatPane(
  layout: LayoutConfig,
  instanceId: string,
  termWidth: number,
  termHeight: number,
  def?: PaneDef,
): LayoutConfig {
  const instance = findPaneInstance(layout, instanceId);
  if (!instance) return layout;
  const remembered = instance.placementMemory?.floating;
  const rect = remembered
    ? clampFloatingRect(remembered, termWidth, termHeight)
    : defaultFloatingRect(termWidth, termHeight, def);
  return floatAtRect(layout, instanceId, rect);
}

export function addPaneFloating(
  layout: LayoutConfig,
  instance: PaneInstanceConfig | string,
  termWidth: number,
  termHeight: number,
  def?: PaneDef,
): LayoutConfig {
  const resolvedInstance = typeof instance === "string" ? createPaneInstance(instance) : instance;
  const withInstance = ensurePaneInstance(layout, resolvedInstance);
  return floatPane(withInstance, resolvedInstance.instanceId, termWidth, termHeight, def);
}

export function bringToFront(layout: LayoutConfig, instanceId: string): LayoutConfig {
  return finalizeLayout(updateFloatingPane(layout, instanceId, { zIndex: maxFloatingZ(layout) + 1 }));
}

export function getRememberedFloatingRect(
  layout: LayoutConfig,
  instanceId: string,
  termWidth: number,
  termHeight: number,
  def?: PaneDef,
): FloatingPlacementMemory {
  const instance = findPaneInstance(layout, instanceId);
  const remembered = instance?.placementMemory?.floating;
  return remembered
    ? clampFloatingRect(remembered, termWidth, termHeight)
    : defaultFloatingRect(termWidth, termHeight, def);
}
