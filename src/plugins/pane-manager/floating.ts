import type { FloatingPaneEntry, LayoutConfig } from "../../types/config";
import type { PaneDef } from "../../types/plugin";

export const MIN_FLOAT_WIDTH = 15;
export const MIN_FLOAT_HEIGHT = 6;

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  fixedGeometry?: boolean;
}

interface LayoutBoundsLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampFloatingRect(rect: FloatingRect, termWidth?: number, termHeight?: number): FloatingRect {
  const width = Math.max(rect.fixedGeometry ? 1 : MIN_FLOAT_WIDTH, Math.round(rect.width));
  const height = Math.max(rect.fixedGeometry ? 1 : MIN_FLOAT_HEIGHT, Math.round(rect.height));
  const maxX = typeof termWidth === "number" ? Math.max(0, termWidth - width) : Number.POSITIVE_INFINITY;
  const maxY = typeof termHeight === "number" ? Math.max(0, termHeight - height) : Number.POSITIVE_INFINITY;
  return {
    x: Math.max(0, Math.min(Math.round(rect.x), maxX)),
    y: Math.max(0, Math.min(Math.round(rect.y), maxY)),
    width,
    height,
    zIndex: rect.zIndex,
    fixedGeometry: rect.fixedGeometry,
  };
}

export function clampFloatingRectWithinBounds(rect: FloatingRect, bounds: LayoutBoundsLike): FloatingRect {
  const width = Math.min(Math.max(rect.fixedGeometry ? 1 : MIN_FLOAT_WIDTH, Math.round(rect.width)), Math.max(1, bounds.width));
  const height = Math.min(Math.max(rect.fixedGeometry ? 1 : MIN_FLOAT_HEIGHT, Math.round(rect.height)), Math.max(1, bounds.height));
  const maxX = bounds.x + Math.max(0, bounds.width - width);
  const maxY = bounds.y + Math.max(0, bounds.height - height);
  return {
    x: Math.max(bounds.x, Math.min(Math.round(rect.x), maxX)),
    y: Math.max(bounds.y, Math.min(Math.round(rect.y), maxY)),
    width,
    height,
    zIndex: rect.zIndex,
    fixedGeometry: rect.fixedGeometry,
  };
}

export function defaultFloatingRect(termWidth: number, termHeight: number, def?: PaneDef): FloatingRect {
  const width = def?.defaultFloatingSize?.width ?? Math.floor(termWidth * 0.6);
  const height = def?.defaultFloatingSize?.height ?? Math.floor(termHeight * 0.6);
  return clampFloatingRect({
    x: Math.floor((termWidth - width) / 2),
    y: Math.floor((termHeight - height) / 2),
    width,
    height,
  }, termWidth, termHeight);
}

export function maxFloatingZ(layout: LayoutConfig): number {
  return layout.floating.reduce((highest, entry) => Math.max(highest, entry.zIndex ?? 50), 50);
}

export function updateFloatingPane(
  layout: LayoutConfig,
  instanceId: string,
  updates: Partial<Pick<FloatingPaneEntry, "x" | "y" | "width" | "height" | "zIndex">>,
): LayoutConfig {
  return {
    ...layout,
    floating: layout.floating.map((entry) => (
      entry.instanceId === instanceId ? { ...entry, ...updates } : entry
    )),
  };
}
