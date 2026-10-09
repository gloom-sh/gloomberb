/** @jsxImportSource react */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BoxRenderable, HostPopoverProps } from "../../../ui";
import { blendHex } from "../../../theme/colors";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { useThemeColors } from "../../../theme/theme-context";

const VIEWPORT_MARGIN = 10;
/** How far a popover kept inside its pane stays off the pane's edge. */
const PANE_MARGIN = 4;
const POPOVER_GAP = 6;
const PANE_SELECTOR = '[data-gloom-role="pane-window"], [data-gloom-role="detached-pane-window"]';
/** `.gloom-popover` in styles.css: above dialogs and toasts. */
const POPOVER_Z_INDEX = 10_001;

interface PopoverPosition {
  left: number;
  top: number;
  visible: boolean;
}

function cssSize(value: number | string | undefined): number | string | undefined {
  return typeof value === "number" ? `${value}px` : value;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where an anchor element is now, in viewport pixels. Null once it is gone
 * from the page (a removed message), so the popover falls back to its trigger.
 */
function anchorEdges(anchor: BoxRenderable): Edges | null {
  const rect = anchor.getBoundingClientRect?.();
  if (rect) {
    if (rect.width === 0 && rect.height === 0) return null;
    return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
  }
  const bounds = anchor.absoluteBounds;
  if (!bounds) return null;
  return {
    left: bounds.x * WEB_CELL_WIDTH,
    top: bounds.y * WEB_CELL_HEIGHT,
    right: (bounds.x + bounds.width) * WEB_CELL_WIDTH,
    bottom: (bounds.y + bounds.height) * WEB_CELL_HEIGHT,
  };
}

/** The area a popover must stay in: the window, and for `pane` the pane that holds its trigger too. */
function placementEdges(wrapper: Element | null, boundary: HostPopoverProps["boundary"]): Edges {
  const viewport = {
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
    right: window.innerWidth - VIEWPORT_MARGIN,
    bottom: window.innerHeight - VIEWPORT_MARGIN,
  };
  const pane = boundary === "pane" ? wrapper?.closest(PANE_SELECTOR)?.getBoundingClientRect() : null;
  if (!pane) return viewport;
  return {
    left: Math.max(viewport.left, pane.left + PANE_MARGIN),
    top: Math.max(viewport.top, pane.top + PANE_MARGIN),
    right: Math.min(viewport.right, pane.right - PANE_MARGIN),
    bottom: Math.min(viewport.bottom, pane.bottom - PANE_MARGIN),
  };
}

/**
 * The popover is portalled to <body>, so its z-index only competes in the root
 * stacking context. A trigger inside a surface stacked above the popover layer
 * (the desktop command bar sits at the top of the z-index range) would open
 * its menu underneath that surface. Lift the popover to the highest z-index on
 * the trigger's ancestor chain instead; the portal comes later in the
 * document, so it still paints on top when the two are equal. Returns
 * undefined when the stylesheet layer is already high enough.
 */
function resolvePopoverZIndex(anchor: Element | null): number | undefined {
  let highest = POPOVER_Z_INDEX;
  for (let element = anchor; element; element = element.parentElement) {
    const zIndex = Number.parseInt(window.getComputedStyle(element).zIndex, 10);
    if (zIndex > highest) highest = zIndex;
  }
  return highest > POPOVER_Z_INDEX ? highest : undefined;
}

export function WebPopover({
  open,
  onOpenChange,
  trigger,
  children,
  anchorPoint,
  anchor,
  boundary = "viewport",
  onPointerEnter,
  onPointerLeave,
  placement = "bottom-start",
  minWidth = 280,
  maxWidth = "min(420px, calc(100vw - 20px))",
  label,
  density = "content",
  focusOnOpen = true,
}: HostPopoverProps) {
  const colors = useThemeColors();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0, visible: false });
  const [zIndex, setZIndex] = useState<number | undefined>(undefined);

  const updatePosition = useCallback(() => {
    const wrapper = anchorRef.current;
    const popover = popoverRef.current;
    if (!wrapper || !popover) return;

    const popoverRect = popover.getBoundingClientRect();
    const triggerRect = wrapper.getBoundingClientRect();
    const elementEdges = anchor ? anchorEdges(anchor) : null;
    // Keyboard-driven popovers can intentionally omit a visible trigger. In
    // that case the anchor wrapper still inherits a line-height, so its DOM
    // rect is not truly empty even though there is nothing useful to anchor to.
    // Center these unanchored menus; explicit pointer/footer coordinates still
    // take precedence below.
    if (!elementEdges && !anchorPoint && (trigger == null || (triggerRect.width === 0 && triggerRect.height === 0))) {
      setPosition({
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(
            (window.innerWidth - popoverRect.width) / 2,
            window.innerWidth - popoverRect.width - VIEWPORT_MARGIN,
          ),
        ),
        top: Math.max(
          VIEWPORT_MARGIN,
          Math.min(
            (window.innerHeight - popoverRect.height) / 2,
            window.innerHeight - popoverRect.height - VIEWPORT_MARGIN,
          ),
        ),
        visible: true,
      });
      return;
    }
    const anchorRect = elementEdges ?? (anchorPoint
      ? {
        left: anchorPoint.x,
        right: anchorPoint.x,
        top: anchorPoint.y,
        bottom: anchorPoint.y,
      }
      : triggerRect);
    const edges = placementEdges(wrapper, boundary);
    const preferredLeft = placement === "bottom-end"
      ? anchorRect.right - popoverRect.width
      : anchorRect.left;
    const left = Math.max(edges.left, Math.min(preferredLeft, edges.right - popoverRect.width));
    const below = anchorRect.bottom + POPOVER_GAP;
    const above = anchorRect.top - popoverRect.height - POPOVER_GAP;
    const top = below + popoverRect.height <= edges.bottom
      ? below
      : Math.max(edges.top, above);
    setPosition({ left, top, visible: true });
  }, [anchor, anchorPoint, boundary, placement, trigger]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }
    setZIndex(resolvePopoverZIndex(anchorRef.current));
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    // New content (a hover card swapped to another name) can change the size
    // the placement was worked out for.
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(updatePosition) : null;
    if (popoverRef.current) resizeObserver?.observe(popoverRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const focusFrame = focusOnOpen
      ? window.requestAnimationFrame(() => popoverRef.current?.focus({ preventScroll: true }))
      : 0;
    const handleOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // Tab leaves a menu, as on every platform, and goes on to move focus.
      if (event.key === "Tab") {
        onOpenChange(false);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      // A trigger that took focus back itself (a select in a dialog) keeps it.
      queueMicrotask(() => {
        const anchor = anchorRef.current;
        if (anchor && !anchor.contains(document.activeElement)) anchor.focus({ preventScroll: true });
      });
    };
    document.addEventListener("mousedown", handleOutsideMouseDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", handleOutsideMouseDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [focusOnOpen, onOpenChange, open]);

  return (
    <>
      <div ref={anchorRef} tabIndex={-1} className="gloom-popover-anchor">
        {trigger}
      </div>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="gloom-popover"
          data-density={density}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onMouseEnter={onPointerEnter}
          onMouseLeave={onPointerLeave}
          style={{
            left: position.left,
            top: position.top,
            zIndex,
            visibility: position.visible ? "visible" : "hidden",
            minWidth: cssSize(minWidth),
            maxWidth: cssSize(maxWidth),
            borderColor: blendHex(colors.border, colors.borderFocused, 0.18),
            background: blendHex(colors.panel, colors.bg, 0.08),
            color: colors.text,
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
