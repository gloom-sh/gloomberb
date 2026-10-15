import { useContext, useEffect, useRef, useState } from "react";
import { isLiveResizing, onLiveResizeEnd } from "./live-resize";
import { LivePaneFrameContext, type CellSize } from "./live-stretch";

/**
 * How long a box's size has to hold still before what is laid out in it
 * settles at that size. A resize's content catches up every 100 ms
 * (live-resize.ts), so a pane under the pointer stays resizing between its
 * catch-ups.
 */
export const RESIZE_SETTLE_MS = 120;

/**
 * How far a box may stretch from the size its layout was made for, on either
 * axis, before the layout is made again mid-resize: past this, tiles and
 * blocks drawn in percentages of the old size would look squashed or pulled.
 */
const MAX_HELD_STRETCH = 1.5;

export interface ResizeHold {
  /** The box's size as it last rendered. */
  size: CellSize;
  /** While the box is resizing, the size its layout holds to; null at rest. */
  held: CellSize | null;
}

function stretch(from: number, to: number): number {
  return from > 0 && to > 0 ? Math.max(from / to, to / from) : Infinity;
}

/**
 * The box rendered at `size`: the first change of a resize holds the layout at
 * the size it had, later ones keep it there, and a stretch past
 * MAX_HELD_STRETCH lays it out again at the new size (still resizing).
 */
export function nextResizeHold(state: ResizeHold, size: CellSize, maxStretch = MAX_HELD_STRETCH): ResizeHold {
  if (state.size.width === size.width && state.size.height === size.height) return state;
  const held = state.held ?? state.size;
  const far = Math.max(stretch(held.width, size.width), stretch(held.height, size.height)) > maxStretch;
  return { size, held: far ? size : held };
}

/** At rest: the layout takes the box's size. */
export function settleResizeHold(state: ResizeHold): ResizeHold {
  return state.held ? { size: state.size, held: null } : state;
}

export interface SettledLayoutSize extends CellSize {
  /**
   * The box is being resized: from the first move of a resize that has its
   * pane's frame, or its first change of size, until it has held still for
   * RESIZE_SETTLE_MS with the pointer let go. Nothing laid out in it should
   * animate meanwhile.
   */
  resizing: boolean;
}

/**
 * Desktop: the size to lay out a surface at whose content is placed in
 * percentages of its box (a heat map's tiles), and whether that box is being
 * resized. A pane resize, a divider, a maximise or restore and a window
 * resize all change the box's size, often once a frame; laying the content
 * out again at every one of them costs a full restyle and moves every tile
 * each time. Instead, while the size changes the layout holds to the size it
 * had and the box stretches it by CSS, and once the size has held still it is
 * laid out once, at the size the box settled on. A stretch too far from the
 * held size lays it out again on the way.
 *
 * `resizing` is the shared signal for anything that animates when its layout
 * changes (a glide, a fade, a pulse): none of it while the size is changing.
 * Off (`enabled: false`, the terminal), the size is the box's at once.
 */
export function useSettledLayoutSize(
  width: number,
  height: number,
  { enabled = true }: { enabled?: boolean } = {},
): SettledLayoutSize {
  const [state, setState] = useState<ResizeHold>(() => ({ size: { width, height }, held: null }));
  let current = state;
  if (state.size.width !== width || state.size.height !== height) {
    // Stored while rendering, so the render that has the new size already lays out at the held one.
    current = enabled ? nextResizeHold(state, { width, height }) : { size: { width, height }, held: null };
    setState(current);
  }

  // A resize that has this pane's frame: it holds still from the first move, before its content catches up.
  const frame = useContext(LivePaneFrameContext);
  const [framed, setFramed] = useState(false);
  const framedRef = useRef(false);
  useEffect(() => {
    // Called on every move: only a resize starting or ending is news.
    const follow = () => {
      const next = enabled && frame !== null && frame.live() !== null;
      if (next === framedRef.current) return;
      framedRef.current = next;
      setFramed(next);
    };
    follow();
    return enabled ? frame?.subscribe(follow) : undefined;
  }, [enabled, frame]);

  useEffect(() => {
    if (!state.held || framed) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopWaiting: (() => void) | null = null;
    const settle = () => {
      timer = null;
      // A box still under the pointer (a sidebar, a split) settles when it is let go, not when the pointer pauses.
      if (isLiveResizing()) {
        stopWaiting = onLiveResizeEnd(() => {
          stopWaiting?.();
          stopWaiting = null;
          timer = setTimeout(settle, RESIZE_SETTLE_MS);
        });
        return;
      }
      setState(settleResizeHold);
    };
    timer = setTimeout(settle, RESIZE_SETTLE_MS);
    return () => {
      if (timer !== null) clearTimeout(timer);
      stopWaiting?.();
    };
  }, [framed, state]);

  const layout = current.held ?? current.size;
  return { width: layout.width, height: layout.height, resizing: enabled && (current.held !== null || framed) };
}
