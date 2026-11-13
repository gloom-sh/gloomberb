import { useCallback, useEffect, useRef } from "react";
import { consumeChartMouseEvent, type ChartMouseEvent, type LocalPlotPointer } from "../../core/pointer";
import { compositeViewportPositions, resolveCompositeWheelPan, resolveCompositeWheelZoom } from "../interactions";
import { isVerticalWheelDirection, type PendingWheel } from "../panel-gestures";
import type { CompositePanelSurfaceProps } from "./props";
import { webFrame } from "./pointer";

/**
 * The wheel over the plot pans it, and with Ctrl zooms it around the pointer.
 * Trackpads fire wheel events faster than the plot can paint, so one frame
 * absorbs every event that arrived since the last one.
 */
export function usePlotWheel({
  frame,
  viewport,
  onPanViewport,
  onZoomViewport,
  onActivate,
  plotWidth,
  plotSpanFactor,
  measuredPlotWidth,
  cellWidthPx,
  isDesktopWeb,
  stopCoast,
  plotPointer,
  updateCursor,
}: Pick<CompositePanelSurfaceProps, "frame" | "viewport" | "onPanViewport" | "onZoomViewport" | "onActivate" | "plotWidth"> & {
  plotSpanFactor: number;
  /** The plot's measured width in cells. */
  measuredPlotWidth: number;
  cellWidthPx: number;
  isDesktopWeb: boolean;
  stopCoast: () => void;
  plotPointer: (event: ChartMouseEvent) => LocalPlotPointer | null;
  updateCursor: (event: ChartMouseEvent) => boolean;
}) {
  const pendingWheelRef = useRef<PendingWheel | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const latestWheelStateRef = useRef({ frame, viewport, onPanViewport, onZoomViewport, plotSpanFactor });
  latestWheelStateRef.current = { frame, viewport, onPanViewport, onZoomViewport, plotSpanFactor };
  const flushWheel = useCallback(() => {
    wheelFrameRef.current = null;
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = null;
    if (!pending) return;
    const latest = latestWheelStateRef.current;
    if (pending.panRatio !== 0) {
      const positions = compositeViewportPositions(latest.frame, latest.viewport);
      const span = positions ? Math.max(positions.end - positions.start, Number.EPSILON) : 0;
      latest.onPanViewport(pending.panRatio * span * latest.plotSpanFactor);
    }
    if (pending.zoomLog !== 0) {
      latest.onZoomViewport(Math.exp(pending.zoomLog), pending.anchorRatio);
    }
  }, []);
  useEffect(() => () => {
    pendingWheelRef.current = null;
    if (wheelFrameRef.current !== null) {
      webFrame.cancelAnimationFrame?.(wheelFrameRef.current);
      wheelFrameRef.current = null;
    }
  }, []);
  return useCallback((event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!scroll) return;
    stopCoast();
    onActivate?.();
    consumeChartMouseEvent(event);
    const pointer = plotPointer(event);
    updateCursor(event);
    const pending = pendingWheelRef.current ?? { panRatio: 0, zoomLog: 0, anchorRatio: 0.5 };
    if (event.modifiers.ctrl && pointer && isVerticalWheelDirection(scroll.direction)) {
      pending.zoomLog += Math.log(resolveCompositeWheelZoom(scroll));
      // The anchor is a fraction of the viewport, so a pointer over the empty
      // right offset anchors on the newest observation instead of past it.
      pending.anchorRatio = Math.min(
        1,
        pointer.cellX / Math.max(plotWidth - 1, 1) * plotSpanFactor,
      );
    } else {
      pending.panRatio += resolveCompositeWheelPan(scroll, measuredPlotWidth * cellWidthPx);
    }
    pendingWheelRef.current = pending;
    if (!isDesktopWeb || typeof webFrame.requestAnimationFrame !== "function") {
      flushWheel();
      return;
    }
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = webFrame.requestAnimationFrame(flushWheel);
    }
  }, [
    cellWidthPx,
    flushWheel,
    isDesktopWeb,
    onActivate,
    plotPointer,
    measuredPlotWidth,
    plotSpanFactor,
    plotWidth,
    updateCursor,
  ]);
}
