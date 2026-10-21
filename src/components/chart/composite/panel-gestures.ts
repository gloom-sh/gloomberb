import type { ChartMouseEvent } from "../core/pointer";
import type { PanelScale } from "../../../time-series/types";
import type { CompositeAxisSide, CompositePanelScene } from "./types";
import type { CompositeValueRange } from "./value-scale";
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
  /** Where the press was, in rows, and the panel's axes scaled by hand then: a drag moves those up and down too. */
  startCellY?: number;
  values?: readonly ValueAxisStart[];
}

/** A value axis as a gesture on it found it. */
export interface ValueAxisStart {
  side: CompositeAxisSide;
  key: string;
  scale: PanelScale;
  start: CompositeValueRange;
}

/** The panel's axes scaled by hand, which a drag on its plot moves up and down. */
export function manualValueAxes(panel: Pick<CompositePanelScene, "axes">): ValueAxisStart[] {
  return (["left", "right"] as const).flatMap((side) => {
    const domain = panel.axes[side];
    return domain?.manual && domain.scaleKey
      ? [{ side, key: domain.scaleKey, scale: domain.scale, start: { min: domain.min, max: domain.max } }]
      : [];
  });
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

/** Wheel steps on a value axis since the last frame: the log of the span's factor, around the pointer's height. */
export interface PendingAxisWheel {
  side: CompositeAxisSide;
  spanLog: number;
  anchorRatio: number;
}

/** Two presses on an axis closer than this, with no drag between, are a double click where the host does not count clicks. */
export const AXIS_DOUBLE_PRESS_MS = 400;

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
