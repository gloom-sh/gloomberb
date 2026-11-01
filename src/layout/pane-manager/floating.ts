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
}

interface LayoutBoundsLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampFloatingRect(rect: FloatingRect, termWidth?: number, termHeight?: number): FloatingRect {
  const preferredWidth = Math.max(MIN_FLOAT_WIDTH, Math.round(rect.width));
  const preferredHeight = Math.max(MIN_FLOAT_HEIGHT, Math.round(rect.height));
  const width = typeof termWidth === "number"
    ? Math.min(preferredWidth, Math.max(1, Math.round(termWidth)))
    : preferredWidth;
  const height = typeof termHeight === "number"
    ? Math.min(preferredHeight, Math.max(1, Math.round(termHeight)))
    : preferredHeight;
  const maxX = typeof termWidth === "number" ? Math.max(0, termWidth - width) : Number.POSITIVE_INFINITY;
  const maxY = typeof termHeight === "number" ? Math.max(0, termHeight - height) : Number.POSITIVE_INFINITY;
  return {
    x: Math.max(0, Math.min(Math.round(rect.x), maxX)),
    y: Math.max(0, Math.min(Math.round(rect.y), maxY)),
    width,
    height,
    zIndex: rect.zIndex,
  };
}

export function clampFloatingRectWithinBounds(rect: FloatingRect, bounds: LayoutBoundsLike): FloatingRect {
  const width = Math.min(Math.max(MIN_FLOAT_WIDTH, Math.round(rect.width)), Math.max(1, bounds.width));
  const height = Math.min(Math.max(MIN_FLOAT_HEIGHT, Math.round(rect.height)), Math.max(1, bounds.height));
  const maxX = bounds.x + Math.max(0, bounds.width - width);
  const maxY = bounds.y + Math.max(0, bounds.height - height);
  return {
    x: Math.max(bounds.x, Math.min(Math.round(rect.x), maxX)),
    y: Math.max(bounds.y, Math.min(Math.round(rect.y), maxY)),
    width,
    height,
    zIndex: rect.zIndex,
  };
}

/** A new floating pane's size: its own default, or 60% of the area each way. */
export function defaultFloatingSize(termWidth: number, termHeight: number, def?: PaneDef): { width: number; height: number } {
  const { width, height } = clampFloatingRect({
    x: 0,
    y: 0,
    width: def?.defaultFloatingSize?.width ?? Math.floor(termWidth * 0.6),
    height: def?.defaultFloatingSize?.height ?? Math.floor(termHeight * 0.6),
  }, termWidth, termHeight);
  return { width, height };
}

export function defaultFloatingRect(termWidth: number, termHeight: number, def?: PaneDef): FloatingRect {
  const { width, height } = defaultFloatingSize(termWidth, termHeight, def);
  return clampFloatingRect({
    x: Math.floor((termWidth - width) / 2),
    y: Math.floor((termHeight - height) / 2),
    width,
    height,
  }, termWidth, termHeight);
}

export function maxFloatingZ(layout: LayoutConfig): number {
  return layout.floating.reduce((highest, entry) => Math.max(highest, entry.zIndex ?? FLOATING_PANE_BASE_Z), FLOATING_PANE_BASE_Z);
}

/** Where floating panes stack from, above the docked panes and the dividers between them. */
const FLOATING_PANE_BASE_Z = 50;

/**
 * The shell's fixed overlays of a pane move, over every pane. A move draws a
 * pair at `under` and `over`: on the desktop the landing preview under the
 * pane on the move (lifted to `over` while it is over a target, or its outline
 * when it was docked); in the terminal, which cannot see through a pane, the
 * docked pane's outline under the landing outline.
 */
export const SHELL_DRAG_Z = { under: 95, over: 96 } as const;

/** The lowest of the shell's fixed overlays over every pane. */
const SHELL_PREVIEW_Z = SHELL_DRAG_Z.under;

/**
 * How far above its own z a floating pane draws: its resize edges one level
 * up (shell/pane/layers.tsx), window mode's highlight up to three
 * (shell/window-mode/overlays.tsx).
 */
const FLOATING_PANE_CHROME_LAYERS = 3;

/**
 * The highest z a floating pane holds, 91: with its chrome above it, still
 * under the drag and dock previews, the window-mode status and the pane menu,
 * which the shell draws at fixed levels over every pane, in the terminal's
 * cells, in the kitty images it cuts around them and on the desktop alike.
 * Raising a pane adds one to the top, so a stack that would pass this is
 * renumbered from the base in the same order; a layout saved with a higher
 * stack is renumbered when it loads.
 */
export const FLOATING_PANE_MAX_Z = SHELL_PREVIEW_Z - FLOATING_PANE_CHROME_LAYERS - 1;

/**
 * The entries with the same front-to-back order and no z above
 * `FLOATING_PANE_MAX_Z`: the same array when none is, else every entry
 * renumbered from the base (equal z keep their array order, as they draw).
 * Past 42 floating panes the numbers cannot fit and the top ones run over.
 */
export function compactFloatingZ(entries: FloatingPaneEntry[]): FloatingPaneEntry[] {
  if (entries.every((entry) => (entry.zIndex ?? FLOATING_PANE_BASE_Z) <= FLOATING_PANE_MAX_Z)) return entries;
  const order = entries
    .map((entry, index) => ({ index, z: entry.zIndex ?? FLOATING_PANE_BASE_Z }))
    .sort((left, right) => left.z - right.z || left.index - right.index);
  const next = [...entries];
  order.forEach(({ index }, rank) => {
    next[index] = { ...entries[index]!, zIndex: FLOATING_PANE_BASE_Z + rank };
  });
  return next;
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
