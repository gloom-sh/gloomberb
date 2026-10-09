import type { ChartMouseEvent } from "../core/pointer";
import { compositeViewportPositions, type CompositeNavigationFrame, type CompositeViewportRange } from "./interactions";

export const COMPOSITE_PANEL_ROLE = "composite-chart-panel";

export function isVerticalWheelDirection(
  direction: "up" | "down" | "left" | "right",
): direction is "up" | "down" {
  return direction === "up" || direction === "down";
}

export interface PanGesture {
  kind: "pan";
  startGlobalX: number;
  frame: CompositeNavigationFrame;
  startViewport: CompositeViewportRange;
  positionsPerCell: number;
}

/**
 * A drag pans in the frame it started in; see `CompositeNavigationFrame`. The
 * plot covers the viewport plus its reserved right offset, so a cell is worth
 * that much time and the bars keep pace with the pointer.
 */
export function startPanGesture(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
  plotWidth: number,
  globalX: number,
  plotSpanFactor: number,
): PanGesture {
  const positions = compositeViewportPositions(frame, viewport);
  const span = positions ? Math.max(positions.end - positions.start, Number.EPSILON) : 1;
  return {
    kind: "pan",
    startGlobalX: globalX,
    frame,
    startViewport: viewport,
    positionsPerCell: span * plotSpanFactor / Math.max(plotWidth, 1),
  };
}

export interface PendingWheel {
  /** Fraction of the visible span, positive toward older observations. */
  panRatio: number;
  zoomLog: number;
  anchorRatio: number;
}

/** Blurs a focused text field, the focus change a consumed mousedown prevents. */
export function releaseEditableFocus(event: ChartMouseEvent): void {
  if (!event.target?.closest?.(`[data-gloom-role="${COMPOSITE_PANEL_ROLE}"]`)) return;
  const active = (globalThis as {
    document?: { activeElement?: { tagName?: string; blur?: () => void } };
  }).document?.activeElement;
  const tag = active?.tagName?.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") return;
  active?.blur?.();
}
