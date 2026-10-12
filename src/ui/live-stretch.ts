import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from "react";
import type { BoxRenderable, LiveBoxFrame } from "./host";

/** A width and a height, in cells. */
export interface CellSize {
  width: number;
  height: number;
}

/**
 * Desktop: a pane whose frame a resize sizes ahead of what it renders. The
 * frame follows the pointer on every move; what its content lays out on the
 * cell grid renders at the new size a few times a second (live-resize.ts).
 */
export interface LivePaneFrame {
  /** The frame's size as its content last rendered. */
  readonly rendered: CellSize;
  /** Where the resize has the frame this move; null when no resize has it. */
  live(): CellSize | null;
  /** Called on every move of a resize, and once more when it ends. */
  subscribe(listener: () => void): () => void;
}

/** Given to a pane's content by the shell; null outside a desktop pane. */
export const LivePaneFrameContext = createContext<LivePaneFrame | null>(null);

/**
 * How a surface's size along one axis moves with its pane's frame during one
 * resize: cells of surface per cell of frame, from where both were when it
 * began.
 */
export interface StretchAxis {
  pane: number;
  own: number;
  slope: number;
}

/** Below this much travel of the frame, in cells, a surface's whole-cell sizes cannot tell its slope apart. */
const LEARN_AFTER_CELLS = 3;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Until it renders at another size, a surface is taken to keep its share of the pane. */
export function startStretchAxis(pane: number, own: number): StretchAxis {
  return { pane, own, slope: pane > 0 ? clamp01(own / pane) : 1 };
}

/**
 * The slope the surface has shown since the resize began, once the frame has
 * moved far enough to tell. Sizes are whole cells, so a change within one of
 * the frame's follows it, and one within a cell of nothing stays put: a chart
 * across the pane, and one of a fixed height in a column of text.
 */
export function learnStretchAxis(axis: StretchAxis, pane: number, own: number): StretchAxis {
  const moved = pane - axis.pane;
  if (Math.abs(moved) < LEARN_AFTER_CELLS) return axis;
  const grew = own - axis.own;
  const slope = Math.abs(grew - moved) <= 1 ? 1 : Math.abs(grew) <= 1 ? 0 : clamp01(grew / moved);
  return slope === axis.slope ? axis : { ...axis, slope };
}

/** The size the surface will render at once its content catches up with a frame of `livePane`. */
export function predictStretchAxis(axis: StretchAxis, renderedPane: number, own: number, livePane: number): number {
  return Math.max(0, own + axis.slope * (livePane - renderedPane));
}

const NO_FOLLOW = { x: false, y: false } as const;

/**
 * The box's size for one move of a resize, in cells: the predicted size on
 * each axis CSS does not follow, its rendered cells on each it does, or null
 * when both are its cells. Always both axes: an axis whose prediction is back
 * at its cells has to be drawn there, not left at the last move's size.
 */
export function liveStretchFrame(
  css: { x: boolean; y: boolean },
  axes: { x: StretchAxis; y: StretchAxis },
  rendered: CellSize,
  own: CellSize,
  live: CellSize,
): LiveBoxFrame | null {
  const width = css.x ? own.width : predictStretchAxis(axes.x, rendered.width, own.width, live.width);
  const height = css.y ? own.height : predictStretchAxis(axes.y, rendered.height, own.height, live.height);
  return width !== own.width || height !== own.height ? { width, height } : null;
}

function sameFrame(a: LiveBoxFrame | null, b: LiveBoxFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return a.width === b.width && a.height === b.height;
}

/**
 * Desktop: keeps a surface laid out on the cell grid (a chart, a heat map)
 * filling its part of a pane, at rest and while a resize sizes the pane's
 * frame ahead of what it renders.
 *
 * The surface takes the box it sits in by CSS where its cells leave a
 * fraction of a cell (`trackSurface`), and during a resize follows the frame
 * by CSS on every axis where the boxes above it do (`followsFrame`): to the
 * pixel, with no render. Pass `fit: false` to keep a surface on its cells.
 *
 * On an axis CSS cannot follow (a box above it with a size of its own, such
 * as a share of the pane), every move gives the box (`width` by `height`
 * cells, as it rendered) the size it will render at once the content catches
 * up, by restyling it outside React, and what lays out inside it by CSS
 * follows: a plot's bitmap stretches, labels placed in percentages move with
 * it, tiles placed in percentages reflow, a canvas that redraws on a resize
 * redraws. When the content renders at the new size the box draws as laid
 * out again, and when the resize ends it is handed back in the commit that
 * lays the pane out. Nothing renders per move. The terminal redraws its cells
 * on every move and has no frame to follow.
 */
export function useLiveStretch(
  box: RefObject<BoxRenderable | null>,
  width: number,
  height: number,
  { fit = true }: { fit?: boolean } = {},
): void {
  const pane = useContext(LivePaneFrameContext);
  const axes = useRef<{ x: StretchAxis; y: StretchAxis } | null>(null);
  // What the element carries now, across re-subscriptions.
  const drawn = useRef<LiveBoxFrame | null>(null);
  useLayoutEffect(() => (fit ? box.current?.trackSurface?.() : undefined), [box, fit]);
  useLayoutEffect(() => {
    if (fit) box.current?.refitSurface?.();
  }, [box, fit, height, width]);
  useLayoutEffect(() => {
    if (!pane) return;
    // A render at a new size may have written the box's laid-out size over
    // what was drawn, so the first follow draws whatever the element holds.
    let redraw = drawn.current !== null;
    const follow = () => {
      const css = box.current?.followsFrame?.() ?? NO_FOLLOW;
      const live = css.x && css.y ? null : pane.live();
      let next: LiveBoxFrame | null = null;
      if (live) {
        const { rendered } = pane;
        const begun = axes.current ?? { x: startStretchAxis(rendered.width, width), y: startStretchAxis(rendered.height, height) };
        const learned = { x: learnStretchAxis(begun.x, rendered.width, width), y: learnStretchAxis(begun.y, rendered.height, height) };
        axes.current = learned;
        next = liveStretchFrame(css, learned, rendered, { width, height }, live);
      } else {
        axes.current = null;
      }
      if (!redraw && sameFrame(drawn.current, next)) return;
      redraw = false;
      drawn.current = next;
      box.current?.setLiveFrame?.(next);
    };
    follow();
    return pane.subscribe(follow);
  }, [box, height, pane, width]);
}
