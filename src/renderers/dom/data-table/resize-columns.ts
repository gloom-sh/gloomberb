import { useContext, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { isLiveResizing, onLiveResizeEnd, onLiveResizeStart } from "../../../ui/live-resize";
import { LivePaneFrameContext } from "../../../ui/live-stretch";
import { hasPendingResizeLayouts, onResizeLayoutChange, RESIZE_SETTLE_MS } from "../../../ui/resize-settle";

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
  /** Excludes spare pane space already distributed into responsive columns. */
  resizeWidth?: number;
  viewportWidth: number;
  /** The owning table measures its shared viewport API; this hook only waits for it. */
  viewportIsCurrent: () => boolean;
  fillAvailableWidth: boolean;
  showHorizontalScrollbar: boolean;
}

/** Keep the current overflow extent while CSS follows the viewport across it. */
function resizeContentWidth(element: HTMLElement, width: TableResizeWidth, interrupted = false): string {
  const content = element.querySelector<HTMLElement>('[data-gloom-role="data-table-scroll-content"]');
  const current = content?.getBoundingClientRect().width ?? width.naturalWidth;
  if (!width.fillAvailableWidth) return `${current}px`;
  if (!width.showHorizontalScrollbar) return "100%";
  const minimum = width.resizeWidth ?? width.naturalWidth;
  if (minimum < width.naturalWidth) {
    const body = content?.parentElement;
    // The borderless, unpadded body can reserve a vertical scrollbar. Match
    // CSS 100% while retaining the fractional width clientWidth rounds away.
    const viewport = body ? body.getBoundingClientRect().width - (body.offsetWidth - body.clientWidth) : undefined;
    if (viewport && Number.isFinite(viewport)) {
      // Responsive widths already include spare pane space. Let that space
      // shrink with the viewport, preserving any painted overflow on press.
      return `max(100%, ${Math.min(current, minimum)}px, calc(${current}px + min(0px, calc(100% - ${viewport}px))))`;
    }
  }
  // A table can fit within the trailing gutter despite being slightly below
  // its natural width. Starting from its actual extent avoids a press jump.
  // A settling table can still be wider than its new natural extent. Taking
  // that smaller target on regrab would cancel the animation with a jump.
  return `max(100%, ${interrupted ? current : Math.min(current, minimum)}px)`;
}

/** Start from painted tracks when releasing resize minima or regrabbing a transition. */
function paintedTemplate(element: HTMLElement, template: string): string {
  const tracks = template.split(/ (?=minmax\()/);
  const flexible = tracks.map((track) => track.endsWith("fr)"));
  const weightTotal = tracks.reduce((sum, track, index) => sum + (flexible[index]
    ? Number(track.slice(track.lastIndexOf(", ") + 2, -3)) : 0), 0);
  // An empty table has no shared content grid; its header owns the tracks.
  for (const role of ["data-table-scroll-content", "data-table-header-row"]) {
    const row = element.querySelector<HTMLElement>(`[data-gloom-role="${role}"]`);
    const computed = row && element.ownerDocument.defaultView?.getComputedStyle(row).gridTemplateColumns;
    if (!computed) continue;
    const widths = computed.split(/\s+/).map(parseFloat);
    if (widths.length !== tracks.length || widths.some((width) => !Number.isFinite(width) || width <= 0)) continue;
    const paintedTotal = widths.reduce((sum, width, index) => sum + (flexible[index] ? width : 0), 0);
    // A common factor keeps the painted ratios while giving CSS comparable
    // weights to interpolate. Pixel-sized fr weights otherwise concentrate
    // the settlement into its last frames. Totals below 1fr leave spare space.
    const scale = weightTotal >= 1 && Number.isFinite(weightTotal) && paintedTotal > 0 && Number.isFinite(paintedTotal)
      ? weightTotal / paintedTotal : 1;
    return tracks.map((track, index) => {
      const comma = track.lastIndexOf(", ");
      if (comma < 0) return track;
      // A wider header can raise the destination floor while it is still
      // transitioning. Regrabbing must keep the narrower painted track.
      const minimum = track.slice("minmax(".length, comma);
      const maximum = flexible[index] ? `${widths[index]! * scale}fr` : `${widths[index]}px`;
      return `minmax(min(${minimum}, ${widths[index]}px), ${maximum})`;
    }).join(" ");
  }
  return template;
}

/**
 * Some panes distribute spare terminal cells among their columns. Their DOM
 * tracks still fill by CSS, but applying those rounded weights at every
 * catch-up would jump the column boundaries. Hold the weights while the
 * pointer is down, then let CSS settle to the new weights after release.
 */
export function useTableResizeColumns(root: RefObject<HTMLElement | null>, template: string, columnIds: string, width: TableResizeWidth): void {
  const scope = useContext(LivePaneFrameContext)?.resizeLayoutScope ?? null;
  const latest = useRef({ template, columnIds, width });
  latest.current = { template, columnIds, width };
  const held = useRef<string | null>(null);
  const pendingFinish = useRef<(() => void) | null>(null);
  const retargetTransition = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settling = false;
    const cancelTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const clearTransition = () => {
      cancelTimer();
      settling = false;
      element.style.setProperty(TRANSITION, "initial");
    };
    const settleTransition = () => {
      if (!settling) return;
      cancelTimer();
      // The hold can outlive its timer when React commits late. Give its
      // actual final tracks a whole transition after that commit.
      if (!hasPendingResizeLayouts(scope)) timer = setTimeout(clearTransition, RESIZE_SETTLE_MS);
    };
    retargetTransition.current = settleTransition;
    const begin = () => {
      const interrupted = settling || held.current !== null;
      const current = latest.current;
      const releasesSpace = (current.width.resizeWidth ?? current.width.naturalWidth) < current.width.naturalWidth;
      const template = interrupted || releasesSpace
        ? paintedTemplate(element, current.template) : current.template;
      const width = resizeContentWidth(element, latest.current.width, interrupted);
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
          settling = true;
          element.style.setProperty(TRANSITION, `grid-template-columns ${RESIZE_SETTLE_MS}ms linear, width ${RESIZE_SETTLE_MS}ms linear`);
          settleTransition();
        }
        element.style.setProperty(COLUMNS, "initial");
        element.style.setProperty(WIDTH, "initial");
      };
      pendingFinish.current();
    };
    const stopBeginning = onLiveResizeStart(begin);
    const stopFinishing = onLiveResizeEnd(finish);
    const stopSettling = onResizeLayoutChange(scope, settleTransition);
    if (isLiveResizing()) begin();
    return () => {
      stopBeginning();
      stopFinishing();
      stopSettling();
      clearTransition();
      element.style.setProperty(COLUMNS, "initial");
      element.style.setProperty(WIDTH, "initial");
      held.current = null;
      pendingFinish.current = null;
      retargetTransition.current = null;
    };
  }, [root, scope]);

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
    retargetTransition.current?.();
  }, [template, width.naturalWidth]);

  useLayoutEffect(() => {
    pendingFinish.current?.();
  }, [width.viewportWidth, width.fillAvailableWidth, width.showHorizontalScrollbar]);
}
