import { useCallback, useLayoutEffect, useState, type RefObject, type WheelEvent } from "react";

const FADE_PX = 32;

/**
 * For a row that scrolls sideways (tab strips, the query bar): fades whichever
 * edge hides more content, so it is clear there is more to reach, and turns a
 * vertical wheel into horizontal scrolling while the row overflows.
 */
export function useHorizontalOverflow(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]) {
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((current) => current.start === start && current.end === end ? current : { start, end });
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
