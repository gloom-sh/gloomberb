import { startTransition, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cssLayoutMode } from "./css-layout";
import type { BoxRenderable } from "./host";
import type { CellSize, LivePaneFrame } from "./live-stretch";
import { isLiveResizing, onLiveResizeEnd } from "./live-resize";

/** `catch-up`: how long a measure waits, at most, to render while the pointer resizes the box. */
const CATCH_UP_MS = 100;

/** In cells: under a twentieth of a px at the default size, below what the browser lays out by (1/64 px). */
const SAME_CELLS = 0.005;

const sameSize = (a: CellSize | null, b: CellSize | null) => (
  a === b || (a !== null && b !== null && Math.abs(a.width - b.width) < SAME_CELLS && Math.abs(a.height - b.height) < SAME_CELLS)
);

/**
 * Measures waiting for the next catch-up. One timer for all of them, so every
 * box the pointer resizes renders at its new size in the same commit.
 */
const due = new Set<() => void>();
let dueTimer: ReturnType<typeof setTimeout> | null = null;

function catchUpSoon(flush: () => void): void {
  due.add(flush);
  if (dueTimer !== null) return;
  dueTimer = setTimeout(() => {
    dueTimer = null;
    const flushes = [...due];
    due.clear();
    startTransition(() => {
      for (const run of flushes) run();
    });
  }, CATCH_UP_MS);
}

interface Measure {
  size: CellSize;
  /** The laid-out size it was measured against: a new one replaces it. */
  laidOut: CellSize;
}

/**
 * CSS layout spike (GLO-544, `css-layout.ts`): the size in cells the browser
 * lays `box` out at, for content that renders for one size (a chart's bitmap,
 * a table's visible rows). The box itself is sized by CSS and never waits for
 * this.
 *
 * `laidOut` is the size the layout gives the box. It is used until the box is
 * measured, and again whenever it changes (a release, another layout), since
 * it is then exact and arrives in the commit that lays the box out. A new
 * measure renders at once at rest. While the pointer resizes the box it
 * renders when the spike's `measure` says: every 100 ms, all boxes in one
 * commit, as a transition (`catch-up`); in the release's commit (`release`);
 * or on every frame (`frame`). Off (`enabled` false, no spike, the terminal):
 * `laidOut`.
 */
export function useMeasuredCells(box: RefObject<BoxRenderable | null>, laidOut: CellSize, enabled: boolean): CellSize {
  const [measure, setMeasure] = useState<Measure | null>(null);
  const { width, height } = laidOut;
  const on = enabled && cssLayoutMode() !== null;
  useLayoutEffect(() => {
    const observe = box.current?.observeSize;
    if (!on || !observe) return;
    const cadence = cssLayoutMode()?.measure ?? "catch-up";
    const base = { width, height };
    let shown: CellSize | null = null;
    let pending: CellSize | null = null;
    const show = (size: CellSize) => {
      pending = null;
      if (sameSize(shown, size)) return;
      shown = size;
      setMeasure(sameSize(size, base) ? null : { size, laidOut: base });
    };
    const flush = () => {
      if (pending) show(pending);
    };
    const stopEnd = onLiveResizeEnd(() => {
      due.delete(flush);
      flush();
    });
    const stopObserve = observe((size) => {
      if (!isLiveResizing()) {
        show(size);
      } else if (cadence === "frame") {
        startTransition(() => show(size));
      } else {
        pending = size;
        if (cadence === "catch-up") catchUpSoon(flush);
      }
    });
    return () => {
      due.delete(flush);
      stopEnd();
      stopObserve();
    };
  }, [box, height, on, width]);
  if (!on || !measure || !sameSize(measure.laidOut, laidOut)) return laidOut;
  return measure.size;
}

/**
 * CSS layout spike: the compatibility bridge for content that still sizes a
 * surface from its cell props below the pane's root (the Fear & Greed
 * history chart). It gives `useLiveStretch` the pane's frame as the browser
 * measures it while the pointer resizes it, so such a surface follows the
 * frame between renders as it does on main, with no drag geometry from JS.
 * `rendered` is the frame's size the content last rendered at.
 */
export function useMeasuredPaneFrame(box: RefObject<BoxRenderable | null>, rendered: CellSize, enabled: boolean): LivePaneFrame | null {
  const on = enabled && cssLayoutMode() !== null;
  const latest = useRef<CellSize | null>(null);
  const listeners = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    const observe = box.current?.observeSize;
    if (!on || !observe) return;
    const notify = () => {
      for (const listener of listeners.current) listener();
    };
    const stopObserve = observe((size) => {
      latest.current = size;
      if (isLiveResizing()) notify();
    });
    const stopEnd = onLiveResizeEnd(notify);
    return () => {
      stopEnd();
      stopObserve();
    };
  }, [box, on]);
  const { width, height } = rendered;
  return useMemo(() => (on ? {
    rendered: { width, height },
    live: () => (isLiveResizing() ? latest.current : null),
    subscribe: (listener: () => void) => {
      listeners.current.add(listener);
      return () => { listeners.current.delete(listener); };
    },
  } : null), [height, on, width]);
}
