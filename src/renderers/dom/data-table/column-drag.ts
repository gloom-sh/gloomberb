import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { COLUMN_DRAG_THRESHOLD_PX, columnDropBoundary, columnDropIndex } from "../../../components/ui/data-table/column-order";
import { hideDragShield, showDragShield } from "../host/drag-shield";

/** A header being dragged: the column's index, and where the drop line stands in the table's content (null where it would stay). */
export interface WebColumnDrag {
  from: number;
  dropLeft: number | null;
}

/** How near the body's side edge the pointer scrolls a wide table toward it while it drags a column, and how far each frame. */
const AUTO_SCROLL_EDGE_PX = 24;
const AUTO_SCROLL_STEP_PX = 8;

interface Span {
  start: number;
  end: number;
}

/** Where the line between two columns stands: in the middle of the gap, or just past the last column. */
function dropLineX(spans: readonly Span[], boundary: number): number | null {
  const before = spans[boundary - 1];
  const after = spans[boundary];
  if (before && after) return (before.end + after.start) / 2;
  const gap = spans.length > 1 ? Math.max(0, spans[1]!.start - spans[0]!.end) : 0;
  if (before) return before.end + gap / 2;
  if (after) return after.start - gap / 2;
  return null;
}

/**
 * A press on a movable header: released where it was, it sorts as a click
 * does; moved past a few pixels, it drags the column, an accent line marks
 * the gap it would drop into, and the release moves it there. A table wider
 * than its body scrolls while the pointer holds at its side edge. Escape, or
 * the window losing focus, puts the column back.
 */
export function useWebColumnDrag({
  contentRef,
  bodyRef,
  anchoredColumns,
  onColumnMove,
  onHeaderClick,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  anchoredColumns: number;
  onColumnMove?: (columnId: string, toIndex: number) => void;
  onHeaderClick?: (columnId: string) => void;
}) {
  const [drag, setDrag] = useState<WebColumnDrag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const latest = useRef({ anchoredColumns, onColumnMove, onHeaderClick });
  latest.current = { anchoredColumns, onColumnMove, onHeaderClick };
  useEffect(() => () => cleanupRef.current?.(), []);

  const startPress = useCallback((columnId: string, from: number, event: ReactMouseEvent<HTMLElement>) => {
    cleanupRef.current?.();
    const startX = event.clientX;
    let pointerX = startX;
    let dragging = false;
    let frame = 0;
    const measure = () => {
      const cells = contentRef.current?.querySelectorAll<HTMLElement>(
        '[data-gloom-role="data-table-header-row"] > [data-gloom-role="data-table-header-cell"]',
      ) ?? [];
      const spans = [...cells].map((cell) => {
        const bounds = cell.getBoundingClientRect();
        return { start: bounds.left, end: bounds.right };
      });
      return { spans, boundary: columnDropBoundary(spans, pointerX, latest.current.anchoredColumns) };
    };
    const show = () => {
      const { spans, boundary } = measure();
      const content = contentRef.current?.getBoundingClientRect();
      const lineX = columnDropIndex(from, boundary) === null ? null : dropLineX(spans, boundary);
      const dropLeft = lineX === null || !content ? null : lineX - content.left;
      setDrag((current) => current?.from === from && current.dropLeft === dropLeft ? current : { from, dropLeft });
    };
    const autoScroll = () => {
      frame = requestAnimationFrame(autoScroll);
      const body = bodyRef.current;
      if (!body || body.scrollWidth <= body.clientWidth) return;
      const bounds = body.getBoundingClientRect();
      const step = pointerX < bounds.left + AUTO_SCROLL_EDGE_PX ? -AUTO_SCROLL_STEP_PX
        : pointerX > bounds.right - AUTO_SCROLL_EDGE_PX ? AUTO_SCROLL_STEP_PX : 0;
      if (step === 0) return;
      const before = body.scrollLeft;
      body.scrollLeft = before + step;
      if (body.scrollLeft !== before) show();
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", handleMove, true);
      document.removeEventListener("mouseup", handleUp, true);
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("blur", cleanup);
      cancelAnimationFrame(frame);
      if (dragging) hideDragShield();
      cleanupRef.current = null;
      setDrag(null);
    };
    const handleMove = (moveEvent: MouseEvent) => {
      if (moveEvent.buttons === 0) {
        cleanup();
        return;
      }
      pointerX = moveEvent.clientX;
      if (!dragging) {
        if (Math.abs(pointerX - startX) < COLUMN_DRAG_THRESHOLD_PX) return;
        dragging = true;
        showDragShield();
        frame = requestAnimationFrame(autoScroll);
      }
      moveEvent.preventDefault();
      show();
    };
    const handleUp = (upEvent: MouseEvent) => {
      pointerX = upEvent.clientX;
      const wasDragging = dragging;
      const { boundary } = measure();
      cleanup();
      const { onColumnMove: move, onHeaderClick: sort } = latest.current;
      if (!wasDragging) {
        sort?.(columnId);
        return;
      }
      const to = columnDropIndex(from, boundary);
      if (to !== null) move?.(columnId, to);
    };
    const handleKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !dragging) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cleanup();
    };
    document.addEventListener("mousemove", handleMove, true);
    document.addEventListener("mouseup", handleUp, true);
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("blur", cleanup);
    cleanupRef.current = cleanup;
  }, [bodyRef, contentRef]);

  return { drag, startPress };
}
