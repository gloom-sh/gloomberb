import { getDockLeafLayouts, type LayoutBounds } from "../plugins/pane-manager";
import type { LayoutConfig } from "../types/config";

export type LayoutPreviewKind = "docked" | "floating" | "detached";

export interface LayoutPreviewRect {
  key: string;
  instanceId: string;
  kind: LayoutPreviewKind;
  rect: LayoutBounds;
  /** Paint order: floating sits over docked, detached over both. */
  depth: number;
}

/** Below this a rect is too small to hold a readable pane header. */
const DEFAULT_MIN_SIZE = 2;

function snapRect(
  rect: LayoutBounds,
  bounds: { width: number; height: number },
  minSize: number,
  round: (value: number) => number,
): LayoutBounds {
  const maxX = Math.max(0, bounds.width - minSize);
  const maxY = Math.max(0, bounds.height - minSize);
  const x = Math.max(0, Math.min(maxX, round(rect.x)));
  const y = Math.max(0, Math.min(maxY, round(rect.y)));
  return {
    x,
    y,
    width: Math.max(minSize, Math.min(bounds.width - x, round(rect.x + rect.width) - x)),
    height: Math.max(minSize, Math.min(bounds.height - y, round(rect.y + rect.height) - y)),
  };
}

/**
 * Docked panes come from the real dock geometry at preview scale; floating and
 * detached panes are stored in screen cells, so they are scaled by the screen
 * the layout is being previewed against. Units are whatever the caller passes:
 * terminal cells or CSS pixels.
 */
export function buildLayoutPreviewRects(
  layout: LayoutConfig,
  bounds: { width: number; height: number },
  screen: { width: number; height: number },
  options?: { minSize?: number; fractional?: boolean },
): LayoutPreviewRect[] {
  const minSize = options?.minSize ?? DEFAULT_MIN_SIZE;
  const round = options?.fractional ? (value: number) => value : Math.round;
  const scaleX = bounds.width / Math.max(1, screen.width);
  const scaleY = bounds.height / Math.max(1, screen.height);
  const scaled = (
    entries: readonly { instanceId: string; x: number; y: number; width: number; height: number }[],
    kind: LayoutPreviewKind,
    depth: number,
  ): LayoutPreviewRect[] => entries.map((entry) => ({
    key: `${kind}:${entry.instanceId}`,
    instanceId: entry.instanceId,
    kind,
    depth,
    rect: snapRect({
      x: entry.x * scaleX,
      y: entry.y * scaleY,
      width: entry.width * scaleX,
      height: entry.height * scaleY,
    }, bounds, minSize, round),
  }));

  return [
    ...getDockLeafLayouts(layout, { x: 0, y: 0, ...bounds }, { precise: true }).map((leaf) => ({
      key: `docked:${leaf.instanceId}`,
      instanceId: leaf.instanceId,
      kind: "docked" as const,
      depth: 1,
      rect: snapRect(leaf.rect, bounds, minSize, round),
    })),
    ...scaled(layout.floating, "floating", 2),
    ...scaled(layout.detached ?? [], "detached", 3),
  ];
}
