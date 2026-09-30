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

    useEffect(() => () => {
      cancelPendingFrame();
      pendingMoveRef.current = null;
      pendingDragRef.current = null;
      document.body.classList.remove("gloom-dragging");
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

    const stopDocumentDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove("gloom-dragging");
      document.removeEventListener("mousemove", handleDocumentMove);
      document.removeEventListener("mouseup", handleDocumentUp);
    };

    const handleDocumentMove = (event: globalThis.MouseEvent) => {
      if (!draggingRef.current) return;
      scheduleFrameMouseHandler(event, "drag");
    };

    const handleDocumentUp = (event: globalThis.MouseEvent) => {
      if (!draggingRef.current) return;
      flushPendingFrameNow();
      callMouseHandler(propsRef.current.onMouse, event, "up");
      callMouseHandler(propsRef.current.onMouseUp, event, "up");
      callMouseHandler(propsRef.current.onMouseDragEnd, event, "drag-end");
      stopDocumentDrag();
    };

    const handleMouseDown = (event: MouseEvent) => {
      const hasSyntheticDrag = typeof propsRef.current.onMouse === "function";
      const hasDirectDrag = typeof propsRef.current.onMouseDrag === "function" || typeof propsRef.current.onMouseDragEnd === "function";
      pendingMoveRef.current = null;
      callMouseHandler(propsRef.current.onMouseDown, event, "down");
      if (event.button !== 0 || (event.isPropagationStopped() && !hasDirectDrag)) return;
      if (!hasSyntheticDrag && !hasDirectDrag) return;
      callMouseHandler(propsRef.current.onMouse, event, "down");
      draggingRef.current = true;
      document.body.classList.add("gloom-dragging");
      document.addEventListener("mousemove", handleDocumentMove);
      document.addEventListener("mouseup", handleDocumentUp);
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
