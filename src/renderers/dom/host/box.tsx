/** @jsxImportSource react */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  type CellMouseEvent,
  type MouseLikeEvent,
  callCellMouseHandler,
  callMouseHandler,
  cancelWebFrame,
  cellBoundsForElement,
  cellMouseEvent,
  requestWebFrame,
} from "./mouse";
import { cleanDomProps, commonStyle } from "./style";

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

    useImperativeHandle(ref, () => cellBoundsForElement(() => elementRef.current, () => propsRef.current) as unknown as HTMLDivElement, []);

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

    const scheduleFrameMouseHandler = (event: MouseLikeEvent, type: "move" | "drag") => {
      // The DOM keeps firing mousemove while a button is held. A move means no
      // button anywhere else in the app, so drags must not surface as moves.
      if (type === "move" && draggingRef.current) return;
      if (type === "move" && typeof propsRef.current.onMouseMove !== "function") return;
      if (type === "drag"
        && typeof propsRef.current.onMouse !== "function"
        && typeof propsRef.current.onMouseDrag !== "function") {
        return;
      }

      const nextEvent = cellMouseEvent(event, type);
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

    const lastPointRef = useRef({ x: 0, y: 0 });
    const dragSessionRef = useRef<{
      move: (event: globalThis.MouseEvent) => void;
      up: (event: globalThis.MouseEvent) => void;
      cancel: () => void;
    } | null>(null);
    const endDocumentDragRef = useRef<(event: globalThis.MouseEvent | null, notify: boolean) => void>(() => {});
    endDocumentDragRef.current = (event, notify) => {
      const session = dragSessionRef.current;
      const wasDragging = draggingRef.current;
      if (!session && !wasDragging) return;
      draggingRef.current = false;
      dragSessionRef.current = null;
      document.body.classList.remove("gloom-dragging");
      if (session) {
        document.removeEventListener("mousemove", session.move);
        document.removeEventListener("mouseup", session.up);
        document.removeEventListener("pointerup", session.up);
        document.removeEventListener("pointercancel", session.cancel);
        window.removeEventListener("blur", session.cancel);
      }
      if (!notify || !wasDragging) return;
      const point = event ?? new MouseEvent("mouseup", {
        clientX: lastPointRef.current.x,
        clientY: lastPointRef.current.y,
        button: 0,
        bubbles: true,
      });
      flushPendingFrameNow();
      callMouseHandler(propsRef.current.onMouse, point, "up");
      callMouseHandler(propsRef.current.onMouseUp, point, "up");
      callMouseHandler(propsRef.current.onMouseDragEnd, point, "drag-end");
    };

    useEffect(() => () => {
      cancelPendingFrame();
      pendingMoveRef.current = null;
      pendingDragRef.current = null;
      endDocumentDragRef.current(null, true);
    }, []);

    const handlesWheel = typeof props.onMouseScroll === "function";
    useEffect(() => {
      const element = elementRef.current;
      if (!element || !handlesWheel) return;
      const handleWheel = (event: WheelEvent) => {
        callMouseHandler(propsRef.current.onMouseScroll, event, "scroll");
      };
      element.addEventListener("wheel", handleWheel, { passive: false });
      return () => element.removeEventListener("wheel", handleWheel);
    }, [handlesWheel]);

    const handleMouseDown = (event: MouseEvent) => {
      const hasSyntheticDrag = typeof propsRef.current.onMouse === "function";
      const hasDirectDrag = typeof propsRef.current.onMouseDrag === "function" || typeof propsRef.current.onMouseDragEnd === "function";
      pendingMoveRef.current = null;
      // A press that never saw mouseup (the window move took the pointer) is still tracked.
      // Finish it before the new press, so its drag-end cannot clear the drag this press starts.
      endDocumentDragRef.current(null, true);
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
        lastPointRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
        // The button is up and mouseup never arrived. End the drag instead of following the cursor.
        if (moveEvent.buttons === 0) {
          endDocumentDragRef.current(moveEvent, true);
          return;
        }
        const dx = moveEvent.clientX - originX;
        const dy = moveEvent.clientY - originY;
        if (!document.body.classList.contains("gloom-dragging")) {
          if (dx * dx + dy * dy < 9) return;
          document.body.classList.add("gloom-dragging");
        }
        scheduleFrameMouseHandler(moveEvent, "drag");
      };
      const up = (upEvent: globalThis.MouseEvent) => {
        endDocumentDragRef.current(upEvent, true);
      };
      const cancel = () => {
        endDocumentDragRef.current(null, true);
      };
      dragSessionRef.current = { move, up, cancel };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
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

    return (
      <div
        {...cleanDomProps(props)}
        data-gloom-hover-bg={hoverBackgroundColor ? "true" : undefined}
        ref={elementRef}
        onMouseDownCapture={typeof props.onMouseDownCapture === "function" ? handleMouseDownCapture : undefined}
        onMouseDown={handleMouseDown}
        onMouseOver={handleMouseOver}
        onMouseMove={(event) => scheduleFrameMouseHandler(event, "move")}
        onMouseUp={(event) => callMouseHandler(propsRef.current.onMouseUp, event, "up")}
        onMouseOut={handleMouseOut}
        style={{
          ...commonStyle(props),
          "--gloom-box-hover-bg": hoverBackgroundColor,
          ...(props.style as CSSProperties | undefined),
          ...(props.visible === false ? { display: "none" } : undefined),
        } as CSSProperties}
      >
        {children as ReactNode}
      </div>
    );
  },
);
