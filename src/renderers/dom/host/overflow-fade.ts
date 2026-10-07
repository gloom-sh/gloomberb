import { useCallback, useLayoutEffect, useState, type RefObject, type WheelEvent } from "react";

const FADE_PX = 32;

export interface HorizontalScrollEdges {
  /** Content is hidden before the left edge. */
  start: boolean;
  /** Content continues past the right edge. */
  end: boolean;
  /** Width of the element's own vertical scrollbar, which a fade must not cover. */
  scrollbarRight: number;
  /** Height of the element's own horizontal scrollbar. */
  scrollbarBottom: number;
}

const NO_EDGES: HorizontalScrollEdges = { start: false, end: false, scrollbarRight: 0, scrollbarBottom: 0 };

/**
 * Tracks which horizontal edges of a scrolling element hide content, updating
 * on scroll and whenever the element or its content resizes.
 */
export function useHorizontalScrollEdges(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]): HorizontalScrollEdges {
  const [edges, setEdges] = useState(NO_EDGES);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const next: HorizontalScrollEdges = {
        start: element.scrollLeft > 1,
        end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
        scrollbarRight: Math.max(0, element.offsetWidth - element.clientWidth),
        scrollbarBottom: Math.max(0, element.offsetHeight - element.clientHeight),
      };
      setEdges((current) => current.start === next.start
        && current.end === next.end
        && current.scrollbarRight === next.scrollbarRight
        && current.scrollbarBottom === next.scrollbarBottom ? current : next);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return edges;
}

/**
 * For a row that scrolls sideways (tab strips, the query bar): fades whichever
 * edge hides more content, so it is clear there is more to reach, and turns a
 * vertical wheel into horizontal scrolling while the row overflows.
 */
export function useHorizontalOverflow(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]) {
  const edges = useHorizontalScrollEdges(ref, deps);

  const onWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) return;
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    element.scrollLeft += event.deltaY;
    event.preventDefault();
  }, []);

  const maskImage = edges.start || edges.end
    ? `linear-gradient(to right, ${edges.start ? `transparent 0, #000 ${FADE_PX}px` : "#000 0"}, ${edges.end ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : "#000 100%"})`
    : undefined;

  return { maskStyle: { maskImage, WebkitMaskImage: maskImage }, onWheel };
}
