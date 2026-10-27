import type { StallEvent } from "../utils/main-thread-stall";

/**
 * Only the freezes a user sat through. The system slows the timers of a
 * window behind others or out of view, sometimes to one a second, and the
 * stall monitor cannot tell that from a freeze: a timer back a second late
 * reads the same either way. A window that has been in front, with focus,
 * since before the stall began ran at full speed, so its late timers are
 * freezes. Anything else is dropped, including a real freeze the user
 * clicked into the window during: missing one beats reporting a false one.
 */
export function forwardAttendedStalls(
  forward: (event: StallEvent) => void,
  target: Window = window,
  now: () => number = () => performance.now(),
): { sink: (event: StallEvent) => void; dispose: () => void } {
  const doc = target.document;
  const attended = () => doc.visibilityState === "visible" && doc.hasFocus();
  // Since when the window has been attended; never while it is not.
  let attendedSince = attended() ? now() : Number.POSITIVE_INFINITY;
  const update = () => {
    if (!attended()) attendedSince = Number.POSITIVE_INFINITY;
    else if (attendedSince === Number.POSITIVE_INFINITY) attendedSince = now();
  };
  target.addEventListener("focus", update);
  target.addEventListener("blur", update);
  doc.addEventListener("visibilitychange", update);
  return {
    sink: (event) => {
      if (attended() && attendedSince <= now() - event.blockedMs) forward(event);
    },
    dispose: () => {
      target.removeEventListener("focus", update);
      target.removeEventListener("blur", update);
      doc.removeEventListener("visibilitychange", update);
    },
  };
}
