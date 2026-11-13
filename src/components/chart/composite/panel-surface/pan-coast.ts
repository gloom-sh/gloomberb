import { useCallback, useEffect, useRef } from "react";
import { PAN_COAST_START_SPEED, PAN_COAST_STOP_SPEED, panCoastStep } from "../panel-gestures";
import type { CompositePanelSurfaceProps } from "./props";
import { webFrame } from "./pointer";

/**
 * A pan let go while still moving keeps going and slows down, on the
 * desktop and web only: in a terminal every frame would upload the plot again.
 */
export function usePanCoast({
  isDesktopWeb,
  plotWidth,
  onPanViewport,
}: Pick<CompositePanelSurfaceProps, "onPanViewport"> & {
  isDesktopWeb: boolean;
  /** The plot's measured width in cells, which the speed is read against. */
  plotWidth: number;
}) {
  const coastFrameRef = useRef<number | null>(null);
  const coastPanRef = useRef(onPanViewport);
  coastPanRef.current = onPanViewport;
  const stopCoast = useCallback(() => {
    if (coastFrameRef.current === null) return;
    webFrame.cancelAnimationFrame?.(coastFrameRef.current);
    coastFrameRef.current = null;
    globalThis.removeEventListener?.("pointerdown", stopCoast, true);
    globalThis.removeEventListener?.("keydown", stopCoast, true);
  }, []);
  const startCoast = useCallback((velocity: number, positionsPerCell: number) => {
    stopCoast();
    const requestFrame = webFrame.requestAnimationFrame;
    const widthCells = Math.max(plotWidth, 1);
    const plotWidthsPerSecond = (speed: number) => Math.abs(speed) * 1000 / widthCells;
    if (!isDesktopWeb || !requestFrame || plotWidthsPerSecond(velocity) < PAN_COAST_START_SPEED) return;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let speed = velocity;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const next = panCoastStep(speed, now - last);
      last = now;
      speed = next.velocity;
      coastPanRef.current(next.cells * positionsPerCell);
      if (plotWidthsPerSecond(speed) < PAN_COAST_STOP_SPEED) stopCoast();
      else coastFrameRef.current = requestFrame(step);
    };
    coastFrameRef.current = requestFrame(step);
    // Any press or key anywhere, a range button or a reset, takes the view back from the coast.
    globalThis.addEventListener?.("pointerdown", stopCoast, true);
    globalThis.addEventListener?.("keydown", stopCoast, true);
  }, [isDesktopWeb, plotWidth, stopCoast]);
  useEffect(() => stopCoast, [stopCoast]);
  return { stopCoast, startCoast };
}
