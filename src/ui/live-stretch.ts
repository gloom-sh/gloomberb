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

function sameFrame(a: LiveBoxFrame | null, b: LiveBoxFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return a.width === b.width && a.height === b.height;
}

/**
 * Desktop: keeps a surface laid out on the cell grid (a chart, a heat map)
 * filling its part of a pane while a resize sizes the pane's frame ahead of
 * what it renders. On every move the box (`width` by `height` cells, as it
 * rendered) takes the size it will render at once the content catches up, by
 * restyling it outside React, and what lays out inside it by CSS follows: a
 * plot's bitmap stretches, labels placed in percentages move with it, tiles
 * placed in percentages reflow, a canvas that redraws on a resize redraws.
 * When the content renders at the new size the box draws as laid out again,
 * and when the resize ends it is handed back in the commit that lays the pane
 * out. Nothing renders per move. The terminal redraws its cells on every move
 * and has no frame to follow. A surface that is its pane's root and takes the
 * pane's whole box (`PANE_FILL`) is sized by CSS instead, and this leaves it
 * alone; the prediction is for surfaces placed inside a pane's own layout.
 */
export function useLiveStretch(box: RefObject<BoxRenderable | null>, width: number, height: number): void {
  const pane = useContext(LivePaneFrameContext);
  const axes = useRef<{ x: StretchAxis; y: StretchAxis } | null>(null);
  // What the element carries now, across re-subscriptions.
  const drawn = useRef<LiveBoxFrame | null>(null);
  useLayoutEffect(() => {
    if (!pane) return;
    // A render at a new size may have written the box's laid-out size over
    // what was drawn, so the first follow draws whatever the element holds.
    let redraw = drawn.current !== null;
    const follow = () => {
      // A pane's root that CSS sizes to the pane (pane-fill.ts) follows the
      // frame on its own, to the pixel: nothing to predict.
      const live = box.current?.fillsPane?.() ? null : pane.live();
      let next: LiveBoxFrame | null = null;
      if (live) {
        const { rendered } = pane;
        const begun = axes.current ?? { x: startStretchAxis(rendered.width, width), y: startStretchAxis(rendered.height, height) };
        const learned = { x: learnStretchAxis(begun.x, rendered.width, width), y: learnStretchAxis(begun.y, rendered.height, height) };
        axes.current = learned;
        const toWidth = predictStretchAxis(learned.x, rendered.width, width, live.width);
        const toHeight = predictStretchAxis(learned.y, rendered.height, height, live.height);
        if (toWidth !== width || toHeight !== height) next = { width: toWidth, height: toHeight };
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
