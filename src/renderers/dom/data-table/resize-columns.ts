import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { isLiveResizing, onLiveResizeEnd, onLiveResizeStart } from "../../../ui/live-resize";
import { RESIZE_SETTLE_MS } from "../../../ui/resize-settle";

const COLUMNS = "--gloom-table-resize-columns";
const WIDTH = "--gloom-table-resize-width";
const TRANSITION = "--gloom-table-column-transition";

/** `initial` makes var() use its fallback instead of a containing table's hold. */
export const TABLE_RESIZE_DEFAULTS: CSSProperties & Record<`--${string}`, string> = {
  [COLUMNS]: "initial",
  [WIDTH]: "initial",
  [TRANSITION]: "initial",
};

interface TableResizeWidth {
  naturalWidth: number;
  viewportWidth: number;
  /** The owning table measures its shared viewport API; this hook only waits for it. */
  viewportIsCurrent: () => boolean;
  fillAvailableWidth: boolean;
  showHorizontalScrollbar: boolean;
}

/** Keep the current overflow extent while CSS follows the viewport across it. */
function resizeContentWidth(element: HTMLElement, width: TableResizeWidth): string {
  const content = element.querySelector<HTMLElement>('[data-gloom-role="data-table-scroll-content"]');
  const current = content?.getBoundingClientRect().width ?? width.naturalWidth;
  if (!width.fillAvailableWidth) return `${current}px`;
  if (!width.showHorizontalScrollbar) return "100%";
  // A table can fit within the trailing gutter despite being slightly below
  // its natural width. Starting from its actual extent avoids a press jump.
  return `max(100%, ${Math.min(current, width.naturalWidth)}px)`;
}

/** A regrab during the settling transition starts from the tracks currently on screen. */
function interruptedTemplate(element: HTMLElement, template: string): string {
  const row = element.querySelector<HTMLElement>('[data-gloom-role="data-table-scroll-content"]');
  const computed = row && element.ownerDocument.defaultView?.getComputedStyle(row).gridTemplateColumns;
  if (!computed) return template;
  const widths = computed.split(/\s+/).map(parseFloat);
  const tracks = template.split(/ (?=minmax\()/);
  if (widths.length !== tracks.length || widths.some((width) => !Number.isFinite(width) || width <= 0)) return template;
  return tracks.map((track, index) => {
    const comma = track.lastIndexOf(", ");
    return comma < 0 ? track : `${track.slice(0, comma + 2)}${widths[index]}${track.endsWith("fr)") ? "fr" : "px"})`;
  }).join(" ");
}

/**
 * Some panes distribute spare terminal cells among their columns. Their DOM
 * tracks still fill by CSS, but applying those rounded weights at every
 * catch-up would jump the column boundaries. Hold the weights while the
 * pointer is down, then let CSS settle to the new weights after release.
 */
export function useTableResizeColumns(root: RefObject<HTMLElement | null>, template: string, columnIds: string, width: TableResizeWidth): void {
  const latest = useRef({ template, columnIds, width });
  latest.current = { template, columnIds, width };
  const held = useRef<string | null>(null);
  const pendingFinish = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTransition = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      element.style.setProperty(TRANSITION, "initial");
    };
    const begin = () => {
      const template = timer === null && held.current === null
        ? latest.current.template : interruptedTemplate(element, latest.current.template);
      const width = resizeContentWidth(element, latest.current.width);
      pendingFinish.current = null;
      clearTransition();
      held.current = latest.current.columnIds;
      element.style.setProperty(COLUMNS, template);
      element.style.setProperty(WIDTH, width);
    };
    const finish = () => {
      if (held.current === null) return;
      pendingFinish.current = () => {
        const width = latest.current.width;
        // The overflow decision deliberately waits until release to measure.
        // Its new width must land before removing the hold, or a shrink would
        // briefly target 100% before switching back to its natural extent.
        if (width.fillAvailableWidth && width.showHorizontalScrollbar && !width.viewportIsCurrent()) return;
        pendingFinish.current = null;
        held.current = null;
        const reducedMotion = element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (!reducedMotion) {
          element.style.setProperty(TRANSITION, `grid-template-columns ${RESIZE_SETTLE_MS}ms linear, width ${RESIZE_SETTLE_MS}ms linear`);
          timer = setTimeout(clearTransition, RESIZE_SETTLE_MS * 2);
        }
        element.style.setProperty(COLUMNS, "initial");
        element.style.setProperty(WIDTH, "initial");
      };
      pendingFinish.current();
    };
    const stopBeginning = onLiveResizeStart(begin);
    const stopFinishing = onLiveResizeEnd(finish);
    if (isLiveResizing()) begin();
    return () => {
      stopBeginning();
      stopFinishing();
      clearTransition();
      element.style.setProperty(COLUMNS, "initial");
      element.style.setProperty(WIDTH, "initial");
      held.current = null;
      pendingFinish.current = null;
    };
  }, [root]);

  useLayoutEffect(() => {
    // A breakpoint or mode switch can replace the columns themselves. The
    // new cells must receive their own tracks, not the previous schema's.
    if (held.current !== null && held.current !== columnIds) {
      held.current = columnIds;
      const element = root.current;
      if (element) {
        element.style.setProperty(WIDTH, resizeContentWidth(element, latest.current.width));
        element.style.setProperty(COLUMNS, template);
      }
    }
  }, [columnIds, root, template]);

  useLayoutEffect(() => {
    pendingFinish.current?.();
  }, [width.viewportWidth, width.fillAvailableWidth, width.showHorizontalScrollbar]);
}
