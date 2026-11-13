import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { BoxRenderable } from "../../../../ui";
import { clamp } from "../../../../utils/math";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../../core/pointer";
import { resolveCompositeWheelZoom } from "../interactions";
import { AXIS_DOUBLE_PRESS_MS, isVerticalWheelDirection, type PendingAxisWheel, type ValueAxisStart } from "../panel-gestures";
import type { CompositeAxisSide } from "../types";
import { resolveAxisDragSpanFactor, zoomValueRange } from "../value-scale";
import { pointerRow, webFrame } from "./pointer";
import type { CompositePanelSurfaceProps } from "./props";

/**
 * A value axis under the pointer: a drag stretches (up) or squeezes (down)
 * it around its middle, the wheel around the pointer, and a double click
 * fits it to the data again. Read through refs, so the handlers stay put.
 */
export function useValueAxisGestures({
  plotRef,
  panel,
  valueScalable,
  onSetValueScale,
  onResetValueScale,
  onActivate,
  isDesktopWeb,
  cellHeightPx,
  fractionalViewport,
}: Pick<CompositePanelSurfaceProps, "panel" | "valueScalable" | "onSetValueScale" | "onResetValueScale" | "onActivate"> & {
  plotRef: RefObject<BoxRenderable | null>;
  isDesktopWeb: boolean;
  cellHeightPx: number;
  fractionalViewport: boolean;
}) {
  const axisGestureRef = useRef<(ValueAxisStart & { startRow: number; moved: boolean }) | null>(null);
  const lastAxisPressRef = useRef<{ side: CompositeAxisSide; at: number } | null>(null);
  const latestAxesRef = useRef({ panel, onSetValueScale, onResetValueScale, onActivate });
  latestAxesRef.current = { panel, onSetValueScale, onResetValueScale, onActivate };
  /** The pointer's height down the panel, 0 at the top and 1 at the bottom. */
  const axisPointerRatio = useCallback((event: ChartMouseEvent): number => {
    const plot = plotRef.current as unknown as { absoluteY?: number; y?: number; height?: number } | null;
    const top = plot?.absoluteY ?? plot?.y;
    const height = plot?.height ?? 0;
    if (top === undefined || height <= 1) return 0.5;
    return clamp((pointerRow(event) - top) / (fractionalViewport ? height : height - 1), 0, 1);
  }, [fractionalViewport]);
  const pressAxis = useCallback((side: CompositeAxisSide, event: ChartMouseEvent) => {
    const latest = latestAxesRef.current;
    const domain = latest.panel.axes[side];
    if (!domain?.scaleKey) return;
    latest.onActivate?.();
    consumeChartMouseEvent(event);
    // The desktop counts clicks; the terminal has two presses close together.
    const now = Date.now();
    const last = lastAxisPressRef.current;
    const double = typeof event.detail === "number"
      ? event.detail >= 2
      : !!last && last.side === side && now - last.at < AXIS_DOUBLE_PRESS_MS;
    if (double) {
      lastAxisPressRef.current = null;
      axisGestureRef.current = null;
      latest.onResetValueScale(latest.panel.id);
      return;
    }
    lastAxisPressRef.current = { side, at: now };
    axisGestureRef.current = {
      side,
      key: domain.scaleKey,
      scale: domain.scale,
      start: { min: domain.min, max: domain.max },
      startRow: pointerRow(event),
      moved: false,
    };
  }, []);
  const dragAxis = useCallback((event: ChartMouseEvent) => {
    const gesture = axisGestureRef.current;
    if (!gesture) return;
    consumeChartMouseEvent(event);
    const deltaPx = (pointerRow(event) - gesture.startRow) * cellHeightPx;
    if (!gesture.moved && Math.abs(deltaPx) < 1) return;
    // A drag is not the first half of a double click.
    gesture.moved = true;
    lastAxisPressRef.current = null;
    const latest = latestAxesRef.current;
    latest.onSetValueScale(
      latest.panel.id,
      gesture.side,
      gesture.key,
      zoomValueRange(gesture.start, gesture.scale, resolveAxisDragSpanFactor(deltaPx), 0.5),
    );
  }, [cellHeightPx]);
  const releaseAxis = useCallback(() => {
    axisGestureRef.current = null;
  }, []);
  const pendingAxisWheelRef = useRef<PendingAxisWheel | null>(null);
  const axisWheelFrameRef = useRef<number | null>(null);
  const flushAxisWheel = useCallback(() => {
    axisWheelFrameRef.current = null;
    const pending = pendingAxisWheelRef.current;
    pendingAxisWheelRef.current = null;
    const latest = latestAxesRef.current;
    const domain = pending ? latest.panel.axes[pending.side] : undefined;
    if (!pending || !domain?.scaleKey || pending.spanLog === 0) return;
    latest.onSetValueScale(
      latest.panel.id,
      pending.side,
      domain.scaleKey,
      zoomValueRange({ min: domain.min, max: domain.max }, domain.scale, Math.exp(pending.spanLog), pending.anchorRatio),
    );
  }, []);
  useEffect(() => () => {
    pendingAxisWheelRef.current = null;
    if (axisWheelFrameRef.current !== null) {
      webFrame.cancelAnimationFrame?.(axisWheelFrameRef.current);
      axisWheelFrameRef.current = null;
    }
  }, []);
  const wheelAxis = useCallback((side: CompositeAxisSide, event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!scroll || !latestAxesRef.current.panel.axes[side]?.scaleKey) return;
    latestAxesRef.current.onActivate?.();
    consumeChartMouseEvent(event);
    if (!isVerticalWheelDirection(scroll.direction)) return;
    const pending = pendingAxisWheelRef.current?.side === side
      ? pendingAxisWheelRef.current
      : { side, spanLog: 0, anchorRatio: 0.5 };
    // Up stretches, as Ctrl and the wheel zoom the plot in.
    pending.spanLog -= Math.log(resolveCompositeWheelZoom(scroll));
    pending.anchorRatio = axisPointerRatio(event);
    pendingAxisWheelRef.current = pending;
    if (!isDesktopWeb || typeof webFrame.requestAnimationFrame !== "function") {
      flushAxisWheel();
      return;
    }
    if (axisWheelFrameRef.current === null) {
      axisWheelFrameRef.current = webFrame.requestAnimationFrame(flushAxisWheel);
    }
  }, [axisPointerRatio, flushAxisWheel, isDesktopWeb]);
  const leftAxisGestures = useMemo(() => valueScalable ? {
    onMouseDown: (event: ChartMouseEvent) => pressAxis("left", event),
    onMouseDrag: dragAxis,
    onMouseUp: releaseAxis,
    onMouseDragEnd: releaseAxis,
    onMouseScroll: (event: ChartMouseEvent) => wheelAxis("left", event),
  } : undefined, [dragAxis, pressAxis, releaseAxis, valueScalable, wheelAxis]);
  const rightAxisGestures = useMemo(() => valueScalable ? {
    onMouseDown: (event: ChartMouseEvent) => pressAxis("right", event),
    onMouseDrag: dragAxis,
    onMouseUp: releaseAxis,
    onMouseDragEnd: releaseAxis,
    onMouseScroll: (event: ChartMouseEvent) => wheelAxis("right", event),
  } : undefined, [dragAxis, pressAxis, releaseAxis, valueScalable, wheelAxis]);
  return { leftAxisGestures, rightAxisGestures };
}
