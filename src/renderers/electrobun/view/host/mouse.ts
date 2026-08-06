import type { MouseEvent, WheelEvent as ReactWheelEvent } from "react";
import type { BoxRenderable } from "../../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";

export type MouseLikeEvent = MouseEvent | ReactWheelEvent | globalThis.MouseEvent | globalThis.WheelEvent;
export type CellMouseEvent = ReturnType<typeof cellMouseEvent>;

type WebFrameCallback = (timestamp: number) => void;

const webAnimationFrameApi = globalThis as typeof globalThis & {
  requestAnimationFrame?: (callback: WebFrameCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
};

export function requestWebFrame(callback: WebFrameCallback): number {
  if (typeof webAnimationFrameApi.requestAnimationFrame === "function") {
    return webAnimationFrameApi.requestAnimationFrame(callback);
  }
  return setTimeout(() => callback(Date.now()), 16) as unknown as number;
}

export function cancelWebFrame(id: number): void {
  if (typeof webAnimationFrameApi.cancelAnimationFrame === "function") {
    webAnimationFrameApi.cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

function resolveScroll(event: MouseLikeEvent) {
  if (!("deltaX" in event) && !("deltaY" in event)) return undefined;
  const wheel = event as WheelEvent;
  const useHorizontal = Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY);
  const delta = useHorizontal ? wheel.deltaX : wheel.deltaY;
  return {
    direction: useHorizontal
      ? (delta > 0 ? "right" : "left")
      : (delta > 0 ? "down" : "up"),
    delta: Math.abs(delta),
  };
}

export function cellMouseEvent(event: MouseLikeEvent, type?: string) {
  const preciseX = event.clientX / WEB_CELL_WIDTH;
  const preciseY = event.clientY / WEB_CELL_HEIGHT;
  return {
    type,
    x: Math.max(0, Math.floor(preciseX)),
    y: Math.max(0, Math.floor(preciseY)),
    preciseX: Math.max(0, preciseX),
    preciseY: Math.max(0, preciseY),
    pixelX: event.clientX,
    pixelY: event.clientY,
    button: event.button,
    target: (event as { target?: unknown }).target,
    detail: "detail" in event && typeof event.detail === "number" ? event.detail : 0,
    timeStamp: event.timeStamp,
    modifiers: {
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
    },
    scroll: resolveScroll(event),
    isDefaultPrevented: () => event.defaultPrevented,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
  };
}

export function mouseHandlers(props: Record<string, unknown>) {
  const wrap = (handler: unknown) => (
    typeof handler === "function"
      ? (event: MouseEvent) => (handler as (event: unknown) => void)(cellMouseEvent(event))
      : undefined
  );
  return {
    onMouseDown: wrap(props.onMouseDown),
    onMouseOver: wrap(props.onMouseOver),
    onMouseMove: wrap(props.onMouseMove),
    onMouseUp: wrap(props.onMouseUp),
    onMouseOut: wrap(props.onMouseOut),
  };
}

export function callMouseHandler(handler: unknown, event: MouseLikeEvent, type?: string): void {
  if (typeof handler !== "function") return;
  (handler as (event: unknown) => void)(cellMouseEvent(event, type));
}

export function callCellMouseHandler(handler: unknown, event: CellMouseEvent): void {
  if (typeof handler !== "function") return;
  (handler as (event: unknown) => void)(event);
}

export function cellBoundsForElement(
  getElement: () => HTMLElement | null,
  getProps: () => Record<string, unknown>,
): BoxRenderable {
  const rect = () => getElement()?.getBoundingClientRect();
  const cellX = () => Math.max(0, (rect()?.left ?? 0) / WEB_CELL_WIDTH);
  const cellY = () => Math.max(0, (rect()?.top ?? 0) / WEB_CELL_HEIGHT);
  const cellWidthValue = () => {
    const props = getProps();
    return typeof props.width === "number" ? props.width : Math.max(0, (rect()?.width ?? 0) / WEB_CELL_WIDTH);
  };
  const cellHeightValue = () => {
    const props = getProps();
    return typeof props.height === "number" ? props.height : Math.max(0, (rect()?.height ?? 0) / WEB_CELL_HEIGHT);
  };

  return {
    get x() { return cellX(); },
    get y() { return cellY(); },
    get width() { return cellWidthValue(); },
    get height() { return cellHeightValue(); },
    get absoluteX() { return cellX(); },
    get absoluteY() { return cellY(); },
    get absoluteBounds() {
      return { x: cellX(), y: cellY(), width: cellWidthValue(), height: cellHeightValue() };
    },
    parent: null,
    getBoundingClientRect: () => {
      const current = rect();
      return {
        x: current?.x ?? 0,
        y: current?.y ?? 0,
        width: current?.width ?? 0,
        height: current?.height ?? 0,
      };
    },
  };
}
