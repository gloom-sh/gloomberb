/** How long reads landing one after another are gathered into one redraw. */
const LANDING_GATHER_MS = 100;

/**
 * A redraw for reads that land one by one (a board's seventy contract
 * histories): the first landing redraws at once, and those in the next
 * `LANDING_GATHER_MS` are drawn together when it ends, so the board redraws a
 * few times rather than once per read. `flush` draws what is waiting at once
 * (the last read landed) and `cancel` drops it (the board moved on).
 */
export function coalescedBump(redraw: () => void, gatherMs = LANDING_GATHER_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  const gather = () => {
    timer = setTimeout(() => {
      timer = undefined;
      if (!waiting) return;
      waiting = false;
      redraw();
      gather();
    }, gatherMs);
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    waiting = false;
  };
  return {
    bump() {
      if (timer !== undefined) {
        waiting = true;
        return;
      }
      redraw();
      gather();
    },
    flush() {
      const draw = waiting;
      cancel();
      if (draw) redraw();
    },
    cancel,
  };
}
