import { startTransition, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { BoxRenderable } from "./host";
import type { CellSize } from "./live-stretch";
import { isLiveResizing, onLiveCatchUp, onLiveResizeEnd } from "./live-resize";

/** In cells: under a twentieth of a px at the default size, below what the browser lays out by (1/64 px). */
const SAME_CELLS = 0.005;

const sameSize = (a: CellSize | null, b: CellSize | null) => (
  a === b || (a !== null && b !== null && Math.abs(a.width - b.width) < SAME_CELLS && Math.abs(a.height - b.height) < SAME_CELLS)
);

/** A measured size; `revealed` when the box took it as it showed again after being hidden (a tab). */
export interface MeasuredCellSize extends CellSize {
  readonly revealed?: boolean;
}

/**
 * The size in cells the browser lays `box` out at, for content that draws for
 * one size: a chart's bitmap, at the pixels its plot really has. The box
 * itself is sized by CSS and never waits for this.
 *
 * Until the box is measured, and wherever nothing measures it (the terminal),
 * it is `laidOut`, the size the layout gives it. At rest a new measure renders
 * at once. While the pointer resizes a frame (live-resize.ts) it waits for the
 * resize's next catch-up, a few times a second, and renders in that commit,
 * with every other box measured in the meantime; the release renders the last
 * one in its own commit.
 */
export function useMeasuredCells(box: RefObject<BoxRenderable | null>, laidOut: CellSize): MeasuredCellSize {
  const [measured, setMeasured] = useState<MeasuredCellSize | null>(null);
  const laidOutRef = useRef(laidOut);
  laidOutRef.current = laidOut;
  useLayoutEffect(() => {
    const observe = box.current?.observeSize;
    if (!observe) return;
    let pending: MeasuredCellSize | null = null;
    const show = (size: MeasuredCellSize) => {
      pending = null;
      // Before anything differs, a measure the layout already gives is no
      // news (the box sized in cells); after, the measure is the truth.
      const asLaidOut = sameSize(size, laidOutRef.current);
      setMeasured((current) => (sameSize(current, size) ? current : current === null && asLaidOut ? null : size));
    };
    const flush = () => {
      if (pending) show(pending);
    };
    const stopCatchUp = onLiveCatchUp(() => {
      if (pending) startTransition(flush);
    });
    const stopEnd = onLiveResizeEnd(flush);
    const stopObserve = observe((size, change) => {
      const next = change.revealed ? { ...size, revealed: true } : size;
      if (isLiveResizing()) pending = next;
      else show(next);
    });
    return () => {
      stopCatchUp();
      stopEnd();
      stopObserve();
    };
  }, [box]);
  return measured ?? laidOut;
}
