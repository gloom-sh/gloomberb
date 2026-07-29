/** @jsxImportSource react */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ScrollBoxRenderable } from "../../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";
import { callMouseHandler } from "./mouse";
import { cleanDomProps, commonStyle } from "./style";
import { useScrollbarActivity } from "../scrollbar-activity";

export const WebScrollBox = forwardRef<ScrollBoxRenderable, Record<string, unknown> & { children?: ReactNode }>(
  function WebScrollBox({ children, ...props }, ref) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const isHeaderLikeScroller = props.scrollX === true && props.scrollY !== true && props.height === 1;
    const [horizontalScrollBarVisible, setHorizontalScrollBarVisible] = useState(
      () => props.scrollX === true && !isHeaderLikeScroller,
    );
    const [verticalScrollBarVisible, setVerticalScrollBarVisible] = useState(
      () => props.scrollY === true,
    );
    const horizontalScrollBarVisibleRef = useRef(horizontalScrollBarVisible);
    const verticalScrollBarVisibleRef = useRef(verticalScrollBarVisible);
    const horizontalScrollChangeHandlersRef = useRef(new Set<() => void>());
    const verticalScrollChangeHandlersRef = useRef(new Set<() => void>());
    const scrollFrameRef = useRef<number | null>(null);
    const lastWheelAtRef = useRef(0);
    const [scrollbarActive, markScrollbarActive] = useScrollbarActivity();

    const getElement = useCallback(() => elementRef.current, []);
    const toCellY = (pixels: number) => Math.max(0, Math.round(pixels / WEB_CELL_HEIGHT));
    const toCellX = (pixels: number) => Math.max(0, Math.round(pixels / WEB_CELL_WIDTH));
    const emitHorizontalScrollChange = useCallback(() => {
      for (const handler of horizontalScrollChangeHandlersRef.current) {
        handler();
      }
    }, []);
    const emitVerticalScrollChange = useCallback(() => {
      for (const handler of verticalScrollChangeHandlersRef.current) {
        handler();
      }
    }, []);
    const emitScrollPositionChanges = useCallback(() => {
      emitVerticalScrollChange();
      emitHorizontalScrollChange();
    }, [emitHorizontalScrollChange, emitVerticalScrollChange]);
    const horizontalScrollBar = useMemo(() => ({
      get visible() {
        return horizontalScrollBarVisibleRef.current;
      },
      set visible(nextVisible: boolean) {
        const normalized = nextVisible === true;
        horizontalScrollBarVisibleRef.current = normalized;
        setHorizontalScrollBarVisible(normalized);
      },
      on(event: "change", handler: () => void) {
        if (event === "change") horizontalScrollChangeHandlersRef.current.add(handler);
      },
      off(event: "change", handler: () => void) {
        if (event === "change") horizontalScrollChangeHandlersRef.current.delete(handler);
      },
    }), []);
    const verticalScrollBar = useMemo(() => ({
      get visible() {
        return verticalScrollBarVisibleRef.current;
      },
      set visible(nextVisible: boolean) {
        const normalized = nextVisible === true;
        verticalScrollBarVisibleRef.current = normalized;
        setVerticalScrollBarVisible(normalized);
      },
      on(event: "change", handler: () => void) {
        if (event === "change") verticalScrollChangeHandlersRef.current.add(handler);
      },
      off(event: "change", handler: () => void) {
        if (event === "change") verticalScrollChangeHandlersRef.current.delete(handler);
      },
    }), []);

    useEffect(() => {
      if (props.scrollX !== true) {
        horizontalScrollBar.visible = false;
      }
    }, [horizontalScrollBar, props.scrollX]);

    useEffect(() => {
      if (props.scrollY !== true) {
        verticalScrollBar.visible = false;
      }
    }, [props.scrollY, verticalScrollBar]);

    useEffect(() => () => {
      if (scrollFrameRef.current != null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    }, []);

    useImperativeHandle(ref, () => ({
      get scrollTop() {
        return toCellY(getElement()?.scrollTop ?? 0);
      },
      set scrollTop(value: number) {
        const element = getElement();
        if (element) {
          element.scrollTop = Math.max(0, value) * WEB_CELL_HEIGHT;
          emitVerticalScrollChange();
        }
      },
      get scrollTopPx() {
        return Math.max(0, getElement()?.scrollTop ?? 0);
      },
      set scrollTopPx(value: number) {
        const element = getElement();
        if (element) {
          element.scrollTop = Math.max(0, value);
          emitVerticalScrollChange();
        }
      },
      get scrollLeft() {
        return toCellX(getElement()?.scrollLeft ?? 0);
      },
      set scrollLeft(value: number) {
        const element = getElement();
        if (element) {
          element.scrollLeft = Math.max(0, value) * WEB_CELL_WIDTH;
          emitHorizontalScrollChange();
        }
      },
      get scrollLeftPx() {
        return Math.max(0, getElement()?.scrollLeft ?? 0);
      },
      set scrollLeftPx(value: number) {
        const element = getElement();
        if (element) {
          element.scrollLeft = Math.max(0, value);
          emitHorizontalScrollChange();
        }
      },
      get scrollHeight() {
        return toCellY(getElement()?.scrollHeight ?? 0);
      },
      get scrollWidth() {
        return toCellX(getElement()?.scrollWidth ?? 0);
      },
      get scrollHeightPx() {
        return Math.max(0, getElement()?.scrollHeight ?? 0);
      },
      get scrollWidthPx() {
        return Math.max(0, getElement()?.scrollWidth ?? 0);
      },
      get viewport() {
        const element = getElement();
        return {
          width: toCellX(element?.clientWidth ?? 0),
          height: toCellY(element?.clientHeight ?? 0),
        };
      },
      get viewportPx() {
        const element = getElement();
        return {
          width: Math.max(0, element?.clientWidth ?? 0),
          height: Math.max(0, element?.clientHeight ?? 0),
        };
      },
      getBoundingClientRect() {
        const rect = getElement()?.getBoundingClientRect();
        return {
          x: rect?.x ?? 0,
          y: rect?.y ?? 0,
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
        };
      },
      horizontalScrollBar,
      verticalScrollBar,
      scrollTo(target: number | { x?: number; y?: number }, y?: number) {
        const element = getElement();
        if (!element) return;
        if (typeof target === "number") {
          element.scrollTop = Math.max(0, target) * WEB_CELL_HEIGHT;
          emitVerticalScrollChange();
          if (typeof y === "number") {
            element.scrollLeft = Math.max(0, y) * WEB_CELL_WIDTH;
            emitHorizontalScrollChange();
          }
          return;
        }
        element.scrollTo({
          left: Math.max(0, target.x ?? toCellX(element.scrollLeft)) * WEB_CELL_WIDTH,
          top: Math.max(0, target.y ?? toCellY(element.scrollTop)) * WEB_CELL_HEIGHT,
        });
        emitScrollPositionChanges();
      },
      scrollToPixels(target: number | { x?: number; y?: number }, y?: number) {
        const element = getElement();
        if (!element) return;
        if (typeof target === "number") {
          element.scrollTop = Math.max(0, target);
          emitVerticalScrollChange();
          if (typeof y === "number") {
            element.scrollLeft = Math.max(0, y);
            emitHorizontalScrollChange();
          }
          return;
        }
        element.scrollTo({
          left: Math.max(0, target.x ?? element.scrollLeft),
          top: Math.max(0, target.y ?? element.scrollTop),
        });
        emitScrollPositionChanges();
      },
    }), [
      emitHorizontalScrollChange,
      emitScrollPositionChanges,
      emitVerticalScrollChange,
      getElement,
      horizontalScrollBar,
      verticalScrollBar,
    ]);

    const scrollable = props.scrollX === true || props.scrollY === true;
    const overflowX = props.scrollX === true ? "auto" : "hidden";
    const overflowY = props.scrollY === true ? "auto" : "hidden";
    const handleScroll = useCallback(() => {
      emitScrollPositionChanges();
      markScrollbarActive();
      if (typeof props.onMouseScroll !== "function") return;
      if (Date.now() - lastWheelAtRef.current < 32) return;
      if (scrollFrameRef.current != null) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        (props.onMouseScroll as () => void)();
      });
    }, [emitScrollPositionChanges, markScrollbarActive, props.onMouseScroll]);
    const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
      markScrollbarActive();
      lastWheelAtRef.current = Date.now();
      callMouseHandler(props.onMouseScroll, event, "scroll");
    }, [markScrollbarActive, props.onMouseScroll]);

    return (
      <div
        {...cleanDomProps(props)}
        ref={elementRef}
        data-gloom-scrollbar-x={props.scrollX === true ? (horizontalScrollBarVisible ? "visible" : "hidden") : undefined}
        data-gloom-scrollbar-y={props.scrollY === true ? (verticalScrollBarVisible ? "visible" : "hidden") : undefined}
        data-gloom-scrollbar-active={scrollbarActive ? "true" : undefined}
        onMouseDown={(event) => callMouseHandler(props.onMouseDown, event, "down")}
        onMouseMove={(event) => callMouseHandler(props.onMouseMove, event, "move")}
        onMouseUp={(event) => callMouseHandler(props.onMouseUp, event, "up")}
        onMouseOut={(event) => callMouseHandler(props.onMouseOut, event, "out")}
        onScroll={scrollable ? handleScroll : undefined}
        onWheel={scrollable ? handleWheel : undefined}
        style={{
          ...commonStyle(props),
          overflowX,
          overflowY,
          ...(props.style as CSSProperties | undefined),
          ...(props.visible === false ? { display: "none" } : undefined),
        }}
      >
        {children as ReactNode}
      </div>
    );
  },
);
