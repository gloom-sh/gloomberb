import type { ChartMouseEvent } from "../../core/pointer";

/** The host's animation frames, where it has them: the desktop and the web. */
export const webFrame = globalThis as typeof globalThis & {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

/** The pointer's height in rows, to a fraction of one where the host reports it. */
export function pointerRow(event: ChartMouseEvent): number {
  return typeof event.preciseY === "number" ? event.preciseY : event.y;
}
