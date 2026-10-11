/**
 * Desktop: the pointer is resizing a frame right now (a pane, a split, a
 * sidebar). The frame follows the pointer by restyling itself, and what is
 * laid out on the cell grid inside it renders at the new size a few times a
 * second (`createCatchUp`). Anything that would render on its own whenever its
 * box changes size, such as a table measuring its viewport in cells, waits for
 * the end instead of rendering once per cell the pointer crosses.
 */
let active = 0;
const endListeners = new Set<() => void>();

/** Starts a resize; call what it returns once, when the pointer lets go or the resize is put back. */
export function beginLiveResize(): () => void {
  active += 1;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    active -= 1;
    if (active > 0) return;
    for (const listener of [...endListeners]) listener();
  };
}

export function isLiveResizing(): boolean {
  return active > 0;
}

/** Called when the last resize under way ends. */
export function onLiveResizeEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => { endListeners.delete(listener); };
}

/**
 * How long content laid out on the cell grid waits, at most, to render at the
 * size a resize has reached. A frame follows every pointer move; drawing a
 * chart or a table at every one of them would cost the frames it follows in.
 */
const LIVE_RESIZE_CATCH_UP_MS = 100;

export interface CatchUp {
  /** A move changed the size: catch up within the interval, if not already due. */
  request(): void;
  cancel(): void;
}

/**
 * Runs `catchUp` one interval after a move, and again one interval after the
 * next move once it has run: a few times a second while the pointer moves,
 * and once more after it stops.
 */
export function createCatchUp(catchUp: () => void, intervalMs = LIVE_RESIZE_CATCH_UP_MS): CatchUp {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    request() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        catchUp();
      }, intervalMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
