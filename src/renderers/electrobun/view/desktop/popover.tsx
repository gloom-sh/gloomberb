/** @jsxImportSource react */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HostPopoverProps } from "../../../../ui";
import { blendHex } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";

const VIEWPORT_MARGIN = 10;
const POPOVER_GAP = 6;

interface PopoverPosition {
  left: number;
  top: number;
  visible: boolean;
}

function cssSize(value: number | string | undefined): number | string | undefined {
  return typeof value === "number" ? `${value}px` : value;
}

export function WebPopover({
  open,
  onOpenChange,
  trigger,
  children,
  anchorPoint,
  placement = "bottom-start",
  minWidth = 280,
  maxWidth = "min(420px, calc(100vw - 20px))",
  label,
}: HostPopoverProps) {
  const colors = useThemeColors();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0, visible: false });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const popoverRect = popover.getBoundingClientRect();
    const triggerRect = anchor.getBoundingClientRect();
    // Keyboard-driven popovers can intentionally omit a visible trigger. In
    // that case the anchor wrapper still inherits a line-height, so its DOM
    // rect is not truly empty even though there is nothing useful to anchor to.
    // Center these unanchored menus; explicit pointer/footer coordinates still
    // take precedence below.
    if (!anchorPoint && (trigger == null || (triggerRect.width === 0 && triggerRect.height === 0))) {
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
    const anchorRect = anchorPoint
      ? {
        left: anchorPoint.x,
        right: anchorPoint.x,
        top: anchorPoint.y,
        bottom: anchorPoint.y,
      }
      : triggerRect;
    const preferredLeft = placement === "bottom-end"
      ? anchorRect.right - popoverRect.width
      : anchorRect.left;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(preferredLeft, window.innerWidth - popoverRect.width - VIEWPORT_MARGIN),
    );
    const below = anchorRect.bottom + POPOVER_GAP;
    const above = anchorRect.top - popoverRect.height - POPOVER_GAP;
    const top = below + popoverRect.height <= window.innerHeight - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, above);
    setPosition({ left, top, visible: true });
  }, [anchorPoint, placement, trigger]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => popoverRef.current?.focus({ preventScroll: true }));
    const handleOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      queueMicrotask(() => anchorRef.current?.focus({ preventScroll: true }));
    };
    document.addEventListener("mousedown", handleOutsideMouseDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", handleOutsideMouseDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onOpenChange, open]);

  return (
    <>
      <div ref={anchorRef} tabIndex={-1} className="gloom-popover-anchor">
        {trigger}
      </div>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="gloom-popover"
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          style={{
            left: position.left,
            top: position.top,
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
