/** @jsxImportSource react */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  type CellMouseEvent,
  type MouseLikeEvent,
  type PinchGestureEvent,
  callCellMouseHandler,
  callMouseHandler,
  cancelWebFrame,
  cellBoundsForElement,
  cellMouseEvent,
  pinchWheelEvent,
  requestWebFrame,
} from "./mouse";
import { hideDragShield, showDragShield } from "./drag-shield";
import { applyLiveFrame } from "./live-frame";
import { observeCellSize } from "./size-observer";
import { fitSurface, surfaceFollows, trackSurface } from "./surface-fit";
import { cleanDomProps, commonStyle, useStableStyle } from "./style";

/** Farther than this from the pointer, in px, a predicted point is noise. */
const MAX_PREDICTION_PX = 48;

type PointerMoveEvent = globalThis.MouseEvent & {
  pointerId?: number;
  getPredictedEvents?: () => Array<{ clientX: number; clientY: number }>;
};

function isPointerMove(event: globalThis.MouseEvent): boolean {
  return typeof (event as PointerMoveEvent).pointerId === "number";
}

/**
 * Where the browser predicts the pointer will be a moment after this move, when
 * it predicts at all (Chrome does for the mouse; WebKit returns none). The
 * event itself already sits at the last of its coalesced points.
 */
function predictedPoint(event: globalThis.MouseEvent): { clientX: number; clientY: number } | null {
  const predicted = (event as PointerMoveEvent).getPredictedEvents?.();
  const next = predicted?.[0];
  if (!next) return null;
  const dx = next.clientX - event.clientX;
  const dy = next.clientY - event.clientY;
  return dx * dx + dy * dy <= MAX_PREDICTION_PX * MAX_PREDICTION_PX ? next : null;
}

function capturePointer(element: HTMLElement | null, pointerId: number | null): { element: HTMLElement; pointerId: number } | null {
  if (!element || pointerId === null || typeof element.setPointerCapture !== "function") return null;
  try {
    element.setPointerCapture(pointerId);
    return { element, pointerId };
  } catch {
    // The pointer is already up or belongs to another frame: drag uncaptured.
    return null;
  }
}

function releasePointer(captured: { element: HTMLElement; pointerId: number } | null): void {
  if (!captured) return;
  try {
    if (captured.element.hasPointerCapture?.(captured.pointerId)) captured.element.releasePointerCapture(captured.pointerId);
  } catch {
    // Released already, by the browser on pointerup.
  }
}

interface BoxHandlers {
  cancelPendingFrame(): void;
  handleMouseDown(event: MouseEvent): void;
  handlePointerDown(event: PointerEvent): void;
  handleMouseDownCapture(event: MouseEvent): void;
  handleMouseOver(event: MouseEvent): void;
  handleMouseOut(event: MouseEvent): void;
  handleMouseMove(event: MouseEvent): void;
  handleMouseUp(event: MouseEvent): void;
}

export const WebBox = forwardRef<HTMLDivElement, Record<string, unknown> & { children?: ReactNode }>(
  function WebBox({ children, ...props }, ref: Ref<HTMLDivElement>) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const draggingRef = useRef(false);
    const frameRef = useRef<number | null>(null);
    const pendingMoveRef = useRef<CellMouseEvent | null>(null);
    const pendingDragRef = useRef<CellMouseEvent | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const hoverBackgroundColor = typeof props.hoverBackgroundColor === "string"
      ? props.hoverBackgroundColor
      : undefined;

    useImperativeHandle(ref, () => {
      const handle = cellBoundsForElement(() => elementRef.current, () => propsRef.current);
      handle.setLiveFrame = (frame) => {
        if (elementRef.current) applyLiveFrame(elementRef.current, frame, propsRef.current);
      };
      handle.observeSize = (listener) => (elementRef.current ? observeCellSize(elementRef.current, listener) : () => {});
      handle.trackSurface = () => (elementRef.current ? trackSurface(elementRef.current) : () => {});
      handle.refitSurface = () => {
        if (elementRef.current) fitSurface(elementRef.current);
      };
      handle.followsFrame = () => (elementRef.current ? surfaceFollows(elementRef.current) : { x: false, y: false });
      return handle as unknown as HTMLDivElement;
    }, []);

    const lastPointRef = useRef({ x: 0, y: 0 });
    // The pointer that pressed this box, so a drag can capture it.
    const pressedPointerRef = useRef<number | null>(null);
    const dragSessionRef = useRef<{
      move: (event: globalThis.MouseEvent) => void;
      up: (event: globalThis.MouseEvent) => void;
      cancel: () => void;
      captured: { element: HTMLElement; pointerId: number } | null;
      /** Pointer events are arriving, so the mousemove after each is a repeat. */
      pointerMoves: boolean;
      /** Moved far enough to be a drag: the drag shield is up. */
      shielded: boolean;
    } | null>(null);
    /**
     * Ends the press. "end" reports a release at `event` (or the last point);
     * "cancel" reports the drag abandoned (the window lost focus or the system
     * took the pointer), so a move can put things back.
     */
    const endDocumentDragRef = useRef<(event: globalThis.MouseEvent | null, outcome: "end" | "cancel") => void>(() => {});
    const handlersRef = useRef<BoxHandlers | null>(null);
    // Created once: they read the latest props through propsRef, so a re-render
    // hands React the same listeners instead of a dozen new closures.
    const handlers = handlersRef.current ??= (() => {
      const cancelPendingFrame = () => {
        if (frameRef.current !== null) {
          cancelWebFrame(frameRef.current);
          frameRef.current = null;
        }
      };

      const flushPendingFrameMouseHandlers = () => {
        const moveEvent = pendingMoveRef.current;
        const dragEvent = pendingDragRef.current;
        pendingMoveRef.current = null;
        pendingDragRef.current = null;

        if (moveEvent) {
          callCellMouseHandler(propsRef.current.onMouseMove, moveEvent);
        }
        if (dragEvent) {
          callCellMouseHandler(propsRef.current.onMouse, dragEvent);
          callCellMouseHandler(propsRef.current.onMouseDrag, dragEvent);
        }
      };

      const flushPendingFrameNow = () => {
        cancelPendingFrame();
        flushPendingFrameMouseHandlers();
      };

      const scheduleFrameMouseHandler = (
        event: MouseLikeEvent,
        type: "move" | "drag",
        ahead: { clientX: number; clientY: number } | null = null,
      ) => {
        // The DOM keeps firing mousemove while a button is held. A move means no
        // button anywhere else in the app, so drags must not surface as moves.
        if (type === "move" && draggingRef.current) return;
        if (type === "move" && typeof propsRef.current.onMouseMove !== "function") return;
        if (type === "drag"
          && typeof propsRef.current.onMouse !== "function"
          && typeof propsRef.current.onMouseDrag !== "function") {
          return;
        }

        const nextEvent = cellMouseEvent(event, type, ahead);
        if (type === "move") {
          pendingMoveRef.current = nextEvent;
        } else {
          pendingDragRef.current = nextEvent;
        }

        if (frameRef.current !== null) return;
        frameRef.current = requestWebFrame(() => {
          frameRef.current = null;
          flushPendingFrameMouseHandlers();
        });
      };

      endDocumentDragRef.current = (event, outcome) => {
        const session = dragSessionRef.current;
        const wasDragging = draggingRef.current;
        if (!session && !wasDragging) return;
        draggingRef.current = false;
        const shielded = session?.shielded === true;
        dragSessionRef.current = null;
        if (shielded) hideDragShield();
        if (session) {
          document.removeEventListener("pointermove", session.move);
          document.removeEventListener("mousemove", session.move);
          document.removeEventListener("mouseup", session.up);
          document.removeEventListener("pointerup", session.up);
          document.removeEventListener("pointercancel", session.cancel);
          window.removeEventListener("blur", session.cancel);
          releasePointer(session.captured);
        }
        if (!wasDragging) return;
        const point = event ?? new MouseEvent("mouseup", {
          clientX: lastPointRef.current.x,
          clientY: lastPointRef.current.y,
          button: 0,
          bubbles: true,
        });
        flushPendingFrameNow();
        callMouseHandler(propsRef.current.onMouse, point, "up");
        callMouseHandler(propsRef.current.onMouseUp, point, "up");
        callMouseHandler(propsRef.current.onMouseDragEnd, point, outcome === "cancel" ? "drag-cancel" : "drag-end");
      };

      const handleMouseDown = (event: MouseEvent) => {
        const hasSyntheticDrag = typeof propsRef.current.onMouse === "function";
        const hasDirectDrag = typeof propsRef.current.onMouseDrag === "function" || typeof propsRef.current.onMouseDragEnd === "function";
        pendingMoveRef.current = null;
        // A press that never saw mouseup (the window move took the pointer) is still tracked.
        // Finish it before the new press, so its drag-end cannot clear the drag this press starts.
        endDocumentDragRef.current(null, "end");
        callMouseHandler(propsRef.current.onMouseDown, event, "down");
        if (event.button !== 0 || (event.isPropagationStopped() && !hasDirectDrag)) return;
        if (!hasSyntheticDrag && !hasDirectDrag) return;
        callMouseHandler(propsRef.current.onMouse, event, "down");
        draggingRef.current = true;
        lastPointRef.current = { x: event.clientX, y: event.clientY };
        const originX = event.clientX;
        const originY = event.clientY;
        const move = (moveEvent: globalThis.MouseEvent) => {
          if (!draggingRef.current) return;
          const current = dragSessionRef.current;
          if (isPointerMove(moveEvent)) {
            if (current) current.pointerMoves = true;
          } else if (current?.pointerMoves) {
            return;
          }
          lastPointRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
          // The button is up and mouseup never arrived. End the drag instead of following the cursor.
          if (moveEvent.buttons === 0) {
            endDocumentDragRef.current(moveEvent, "end");
            return;
          }
          const dx = moveEvent.clientX - originX;
          const dy = moveEvent.clientY - originY;
          if (current && !current.shielded) {
            if (dx * dx + dy * dy < 9) return;
            current.shielded = true;
            showDragShield(elementRef.current);
            // Captured once it is a drag (a click keeps its usual target), the
            // moves skip hit testing and leave every other element's hover state
            // alone: nothing under the pointer restyles or repaints while a pane,
            // divider or chart is dragged across it. The document listeners still
            // see every move.
            if (!current.captured) current.captured = capturePointer(elementRef.current, pressedPointerRef.current);
          }
          scheduleFrameMouseHandler(moveEvent, "drag", predictedPoint(moveEvent));
        };
        const up = (upEvent: globalThis.MouseEvent) => {
          endDocumentDragRef.current(upEvent, "end");
        };
        const cancel = () => {
          endDocumentDragRef.current(null, "cancel");
        };
        dragSessionRef.current = { move, up, cancel, captured: null, pointerMoves: false, shielded: false };
        document.addEventListener("pointermove", move);
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
      };

      const handlePointerDown = (event: PointerEvent) => {
        pressedPointerRef.current = event.pointerId;
      };

      const handleMouseDownCapture = (event: MouseEvent) => {
        callMouseHandler(propsRef.current.onMouseDownCapture, event, "down");
      };

      const handleMouseOver = (event: MouseEvent) => {
        callMouseHandler(propsRef.current.onMouseOver, event, "over");
      };

      const handleMouseOut = (event: MouseEvent) => {
        pendingMoveRef.current = null;
        callMouseHandler(propsRef.current.onMouseOut, event, "out");
      };

      return {
        cancelPendingFrame,
        handleMouseDown,
        handlePointerDown,
        handleMouseDownCapture,
        handleMouseOver,
        handleMouseOut,
        handleMouseMove: (event: MouseEvent) => scheduleFrameMouseHandler(event, "move"),
        handleMouseUp: (event: MouseEvent) => callMouseHandler(propsRef.current.onMouseUp, event, "up"),
      };
    })();

    useEffect(() => () => {
      handlers.cancelPendingFrame();
      pendingMoveRef.current = null;
      pendingDragRef.current = null;
      endDocumentDragRef.current(null, "end");
    }, []);

    const handlesWheel = typeof props.onMouseScroll === "function";
    const pinchAsWheel = handlesWheel && props.pinchAsWheel === true;
    useEffect(() => {
      const element = elementRef.current;
      if (!element || !handlesWheel) return;
      // WebKit pinches with gesture events; with `pinchAsWheel` they reach the
      // handler as the Ctrl+wheel Chromium sends for one. The wheel events a
      // newer WebKit adds for the same pinch are dropped, so it zooms once.
      let pinching = false;
      let pinchScale = 1;
      const handleWheel = (event: WheelEvent) => {
        if (pinching && event.ctrlKey) {
          event.preventDefault();
          return;
        }
        // A plain scroll means the pinch is over, whatever became of its end.
        pinching = false;
        callMouseHandler(propsRef.current.onMouseScroll, event, "scroll");
      };
      const startPinch = (event: Event) => {
        event.preventDefault();
        pinching = true;
        pinchScale = (event as PinchGestureEvent).scale || 1;
      };
      const changePinch = (event: Event) => {
        event.preventDefault();
        const scale = (event as PinchGestureEvent).scale;
        const step = pinchScale > 0 && scale > 0 ? scale / pinchScale : 1;
        if (scale > 0) pinchScale = scale;
        const wheel = pinchWheelEvent(event as PinchGestureEvent, step);
        if (wheel) callCellMouseHandler(propsRef.current.onMouseScroll, wheel);
      };
      const endPinch = (event: Event) => {
        event.preventDefault();
        pinching = false;
      };
      element.addEventListener("wheel", handleWheel, { passive: false });
      if (pinchAsWheel) {
        element.addEventListener("gesturestart", startPinch);
        element.addEventListener("gesturechange", changePinch);
        element.addEventListener("gestureend", endPinch);
      }
      return () => {
        element.removeEventListener("wheel", handleWheel);
        element.removeEventListener("gesturestart", startPinch);
        element.removeEventListener("gesturechange", changePinch);
        element.removeEventListener("gestureend", endPinch);
      };
    }, [handlesWheel, pinchAsWheel]);

    const handlesDrag = typeof props.onMouse === "function"
      || typeof props.onMouseDrag === "function"
      || typeof props.onMouseDragEnd === "function";
    const style = useStableStyle({
      ...commonStyle(props),
      "--gloom-box-hover-bg": hoverBackgroundColor,
      ...(props.style as CSSProperties | undefined),
      ...(props.visible === false ? { display: "none" } : undefined),
    } as CSSProperties);
    return (
      <div
        {...cleanDomProps(props)}
        data-gloom-hover-bg={hoverBackgroundColor ? "true" : undefined}
        ref={elementRef}
        onMouseDownCapture={typeof props.onMouseDownCapture === "function" ? handlers.handleMouseDownCapture : undefined}
        onPointerDown={handlesDrag ? handlers.handlePointerDown : undefined}
        onMouseDown={handlers.handleMouseDown}
        onMouseOver={handlers.handleMouseOver}
        onMouseMove={handlers.handleMouseMove}
        onMouseUp={handlers.handleMouseUp}
        onMouseOut={handlers.handleMouseOut}
        style={style}
      >
        {children as ReactNode}
      </div>
    );
  },
);
