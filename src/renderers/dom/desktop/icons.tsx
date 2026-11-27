/** @jsxImportSource react */
import { releasePointerFocus } from "../host/focus-scope";
import { formatShortcutForHost } from "../../../app/keybindings/labels";
import { ariaKeyShortcut } from "./dialog-actions";
import { PANE_SELECTOR, placementEdges } from "./popover";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ICON_GROUP_ATTRIBUTE, type IconButtonProps, type IconName, type IconProps } from "../../../components/ui/icon";
import { TOOLTIP_SURFACE_STYLE } from "../../../components/ui/frame";
import { usePaneFocused } from "../../../state/app/activity";

/** The desktop icon set, drawn on a 12-unit grid in the current colour. */
const ICONS: Record<IconName, ReactNode> = {
  more: (
    <>
      <circle cx="2" cy="6" r="1.1" fill="currentColor" />
      <circle cx="6" cy="6" r="1.1" fill="currentColor" />
      <circle cx="10" cy="6" r="1.1" fill="currentColor" />
    </>
  ),
  // A question mark, drawn like the other bare glyphs (the pane's `...`).
  help: (
    <>
      <path d="M4.2 4.3a1.85 1.85 0 1 1 2.65 1.65c-.55.28-.85.62-.85 1.22v.33" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6" cy="9.55" r=".82" fill="currentColor" />
    </>
  ),
  close: <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  zap: <path d="M7.1 1.2 2.7 6.5h3.1l-.7 4.3 4.4-5.5H6.4l.7-4.1Z" fill="currentColor" />,
  sqrt: <path d="M1.5 6.6h1.6l1.8 3.6L7.6 2h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  // A bell on its rim, with the clapper under it: the pane notifies you.
  bell: (
    <>
      <path d="M3.3 8.7V6a2.7 2.7 0 0 1 5.4 0v2.7" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2 8.7h8M6 2.1v1.2M5 10.5h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  // A ring with four ticks and a centre dot: a reading marked over the data.
  marker: (
    <>
      <circle cx="6" cy="6" r="3.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 1.2v2.4M6 8.4v2.4M1.2 6h2.4M8.4 6h2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="6" r=".9" fill="currentColor" />
    </>
  ),
  lock: (
    <>
      <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" fill="currentColor" />
      <path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  warning: (
    <>
      <path d="M5.3 1.7a.8.8 0 0 1 1.4 0l4.1 7.5a.8.8 0 0 1-.7 1.2H1.9a.8.8 0 0 1-.7-1.2l4.1-7.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 4.4v2.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="6" cy="8.6" r=".6" fill="currentColor" />
    </>
  ),
  back: <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  "chevron-down": <path d="M3 4.8l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  "chevron-right": <path d="M4.8 3l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  search: (
    <>
      <circle cx="5.2" cy="5.2" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.7 7.7L10.2 10.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  plus: <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  check: <path d="M2.6 6.4l2.3 2.3 4.6-5.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  minimize: <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  maximize: <rect x="2.5" y="2.5" width="7" height="7" rx="0.8" stroke="currentColor" strokeWidth="1.2" />,
  // Drawn on a 24-unit grid and scaled, so strokes match the chat pane's
  // original icons at the same pixel size.
  cloud: (
    <g transform="scale(0.5)">
      <path d="M7.5 18.5h9.1a4.4 4.4 0 0 0 .8-8.7 6.1 6.1 0 0 0-11.7 1.7A3.6 3.6 0 0 0 7.5 18.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
  "sound-on": (
    <g transform="scale(0.5)">
      <path d="M4.5 9.5v5h3.2l4.8 4v-13l-4.8 4H4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 8.5a5 5 0 0 1 0 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M18.8 5.8a9 9 0 0 1 0 12.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  ),
  "sound-off": (
    <g transform="scale(0.5)">
      <path d="M4.5 9.5v5h3.2l4.8 4v-13l-4.8 4H4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 5 5 19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  ),
  // A media player's play and pause, solid so they read at the size of text.
  play: <path d="M3.6 2.2v7.6a.5.5 0 0 0 .76.43l6.1-3.8a.5.5 0 0 0 0-.86l-6.1-3.8a.5.5 0 0 0-.76.43Z" fill="currentColor" />,
  pause: (
    <>
      <rect x="2.9" y="2.3" width="2.3" height="7.4" rx=".6" fill="currentColor" />
      <rect x="6.8" y="2.3" width="2.3" height="7.4" rx=".6" fill="currentColor" />
    </>
  ),
  user: (
    <g transform="scale(0.5)">
      <circle cx="12" cy="8.5" r="3.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  ),
  "sort-up": <path d="M3.2 7.4 6 4.6l2.8 2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  "sort-down": <path d="M3.2 4.6 6 7.4l2.8-2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  // Two columns of three dots: the pane's drag handle.
  grip: (
    <>
      <circle cx="4.4" cy="3" r="0.9" fill="currentColor" />
      <circle cx="7.6" cy="3" r="0.9" fill="currentColor" />
      <circle cx="4.4" cy="6" r="0.9" fill="currentColor" />
      <circle cx="7.6" cy="6" r="0.9" fill="currentColor" />
      <circle cx="4.4" cy="9" r="0.9" fill="currentColor" />
      <circle cx="7.6" cy="9" r="0.9" fill="currentColor" />
    </>
  ),
  // A framed picture: a sun over hills.
  image: (
    <>
      <rect x="1.5" y="2.25" width="9" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4.4" cy="4.9" r="0.85" fill="currentColor" />
      <path d="M2 9.1 4.7 6.6l1.6 1.5 1.8-2 2.4 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // A hand with the thumb raised, on the 24-unit grid; the thumbs down is the
  // same hand turned over.
  "thumbs-up": (
    <g transform="scale(0.5)">
      <rect x="3" y="10" width="4" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M7 10l3.5-6.5a1.8 1.8 0 0 1 3.3 1.2L13 9.5h5.6a2 2 0 0 1 2 2.4l-1.4 6.5a2 2 0 0 1-2 1.6H7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
  "thumbs-down": (
    <g transform="scale(0.5) rotate(180 12 12)">
      <rect x="3" y="10" width="4" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M7 10l3.5-6.5a1.8 1.8 0 0 1 3.3 1.2L13 9.5h5.6a2 2 0 0 1 2 2.4l-1.4 6.5a2 2 0 0 1-2 1.6H7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
  // Ask Gloom: a four-point spark, outlined like the header's other glyphs.
  ask: (
    <path
      d="M6 1.6C6.35 4.1 7.9 5.65 10.4 6 7.9 6.35 6.35 7.9 6 10.4 5.65 7.9 4.1 6.35 1.6 6 4.1 5.65 5.65 4.1 6 1.6Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  ),
  // A robot's head: an antenna, two eyes and a mouth.
  bot: (
    <>
      <path d="M6 1.9v1.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="6" cy="1.45" r=".8" fill="currentColor" />
      <rect x="1.9" y="3.6" width="8.2" height="6.6" rx="1.7" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="6.3" r=".95" fill="currentColor" />
      <circle cx="7.5" cy="6.3" r=".95" fill="currentColor" />
      <path d="M4.7 8.35h2.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </>
  ),
  // The Gloom mark: a solid core in a ring.
  team: (
    <>
      <circle cx="6" cy="6" r="4.45" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="6" cy="6" r="2.25" fill="currentColor" />
    </>
  ),
  // A cut gem: the table on top, the point below.
  pro: (
    <>
      <path d="M3.6 2.4h4.8l2.3 2.9L6 10.4 1.3 5.3l2.3-2.9Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M1.5 5.3h9M4.8 2.5 4.3 5.3 6 10.1l1.7-4.8-.5-2.8" stroke="currentColor" strokeWidth=".9" strokeLinejoin="round" />
    </>
  ),
  // A clock face at ten past: data that arrives late.
  clock: (
    <>
      <circle cx="6" cy="6" r="4.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.4V6l1.9 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // A pencil, for changing something in place.
  edit: (
    <>
      <path d="M2.2 9.8l.5-2.3 5.4-5.4a1.1 1.1 0 0 1 1.6 0l.2.2a1.1 1.1 0 0 1 0 1.6L4.5 9.3l-2.3.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M7.3 2.9l1.8 1.8" stroke="currentColor" strokeWidth="1.1" />
    </>
  ),
  // An envelope: a message written to you.
  mail: (
    <>
      <rect x="1.5" y="2.75" width="9" height="6.5" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2 3.4 6 6.5l4-3.1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // A reply: an arrow that turns back to the left, as a mail reply's does.
  reply: (
    <>
      <path d="M4.6 2.6 1.8 5.4l2.8 2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.2 5.4h4.4a3.4 3.4 0 0 1 3.4 3.4v.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  // A reaction: a smiling face, outlined like the other glyphs.
  react: (
    <>
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="5" r=".75" fill="currentColor" />
      <circle cx="7.5" cy="5" r=".75" fill="currentColor" />
      <path d="M4.1 7.2a2.2 2.2 0 0 0 3.8 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </>
  ),
  restore: (
    <>
      <rect x="2" y="4" width="6" height="6" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 4V2.8A.8.8 0 0 1 4.8 2H9.2a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H8" stroke="currentColor" strokeWidth="1.1" />
    </>
  ),
};

export function WebIcon({ name, size = 12, color, fullHeight }: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      data-gloom-icon={name}
      // The viewBox keeps its size and sits in the middle of the taller box (preserveAspectRatio's default).
      style={{ flex: "none", display: "block", color, ...(fullHeight ? { height: "100%" } : {}) }}
    >
      {ICONS[name]}
    </svg>
  );
}

function pressEventFrom(
  target: HTMLElement,
  pixelX: number,
  pixelY: number,
  event: { preventDefault(): void; stopPropagation(): void; button?: number },
) {
  return {
    target,
    pixelX,
    pixelY,
    button: event.button ?? 0,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
  };
}

/** Between a focus label and the icons it names: clear of the focus ring, as a popover is of its trigger. */
const FOCUS_LABEL_GAP = 6;

/** How far past a list's edge a group may reach and still count as shown: a rounded pixel, never a row. */
const SCROLL_CLIP_SLACK = 1;

/**
 * Whether a box between the button and its pane cuts into `group` (a list the
 * row was scrolled out of, or any other box that clips what is in it). A list
 * keeps rows past its edges in the page, so the group still has a place
 * there: behind whatever is beside the list, such as a chat's composer.
 */
function clippedInsidePane(button: HTMLElement, group: DOMRect): boolean {
  const pane = button.closest(PANE_SELECTOR);
  for (let box = button.parentElement; box && box !== pane; box = box.parentElement) {
    const { display, overflowX, overflowY } = window.getComputedStyle(box);
    // A box that draws nothing of its own (display: contents) clips nothing.
    if (display === "contents" || (overflowX === "visible" && overflowY === "visible")) continue;
    const shown = box.getBoundingClientRect();
    if (overflowY !== "visible" && (group.top < shown.top - SCROLL_CLIP_SLACK || group.bottom > shown.bottom + SCROLL_CLIP_SLACK)) return true;
    if (overflowX !== "visible" && (group.left < shown.left - SCROLL_CLIP_SLACK || group.right > shown.right + SCROLL_CLIP_SLACK)) return true;
  }
  return false;
}

/**
 * Where a focus label goes, in viewport pixels: after the button's group if
 * it fits in the pane, else before it, else under it (over it when that
 * leaves the pane); always clear of the group's icons. Null while the group
 * is scrolled out of the pane, or any way out of a list inside it, when there
 * is nothing to name: the label is on the page, where no list would clip it.
 */
function focusLabelPlace(button: HTMLElement, label: { width: number; height: number }): { left: number; top: number } | null {
  const group = (button.closest(`[${ICON_GROUP_ATTRIBUTE}]`) ?? button).getBoundingClientRect();
  const edges = placementEdges(button, "pane");
  const middle = group.top + group.height / 2;
  if (middle < edges.top || middle > edges.bottom || clippedInsidePane(button, group)) return null;
  const beside = Math.max(edges.top, Math.min(group.top + (group.height - label.height) / 2, edges.bottom - label.height));
  const after = group.right + FOCUS_LABEL_GAP;
  if (after + label.width <= edges.right) return { left: after, top: beside };
  const before = group.left - FOCUS_LABEL_GAP - label.width;
  if (before >= edges.left) return { left: before, top: beside };
  const left = Math.max(edges.left, Math.min(group.right - label.width, edges.right - label.width));
  const below = group.bottom + FOCUS_LABEL_GAP;
  return { left, top: below + label.height <= edges.bottom ? below : group.top - FOCUS_LABEL_GAP - label.height };
}

/**
 * The name of a focused icon button, for the keyboard: what its tooltip says
 * under the pointer. Portalled to the page so no row or list clips it, kept
 * on its group wherever the group goes, hidden while a list hides the group,
 * and never in the way of a press.
 */
function IconFocusLabel({ button, text }: { button: RefObject<HTMLButtonElement | null>; text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const target = button.current;
    const label = ref.current;
    if (!target || !label) return;
    let frame = 0;
    let drawn: string | null = null;
    // Placed each frame, for as long as the keyboard is on the icon: a row
    // moves on a scroll, and also when a message arrives, a row above it
    // changes height or the list is given less room, which no event reports.
    // Written to the element itself, so the label is drawn where its group
    // is in that same frame, and is gone in the frame a list hides the group.
    const follow = () => {
      const place = focusLabelPlace(target, { width: label.offsetWidth, height: label.offsetHeight });
      const next = place ? `${place.left}px ${place.top}px` : "";
      if (next !== drawn) {
        drawn = next;
        label.style.visibility = place ? "visible" : "hidden";
        if (place) {
          label.style.left = `${place.left}px`;
          label.style.top = `${place.top}px`;
        }
      }
      frame = window.requestAnimationFrame(follow);
    };
    follow();
    return () => window.cancelAnimationFrame(frame);
  }, [button, text]);
  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      data-gloom-role="icon-button-focus-label"
      className="gloom-icon-focus-label"
      style={{
        ...TOOLTIP_SURFACE_STYLE,
        // One line high, as the icons are, so it stays on their row.
        padding: "0 var(--gloom-space-sm)",
        // Hidden until it is placed; its place is then kept on the element (see the effect above).
        left: 0,
        top: 0,
        visibility: "hidden",
      }}
    >
      {text}
    </div>,
    document.body,
  );
}

export function WebIconButton({
  icon,
  label,
  title,
  shortcut,
  hasPopup,
  expanded,
  onPress,
  pressed,
  color,
  disabled = false,
  size = 12,
  stopPropagation = true,
  onHoverChange,
  focusLabel = false,
}: IconButtonProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const name = title ?? (shortcut ? `${label} (${formatShortcutForHost(shortcut, "platform")})` : label);
  const paneFocused = usePaneFocused();
  // Tab and Shift-Tab move the app's focus to another pane: the icon lets go
  // of the page's focus too, so neither its label nor Enter stays behind here.
  useEffect(() => {
    if (focusLabel && keyboardFocused && paneFocused === false) ref.current?.blur();
  }, [focusLabel, keyboardFocused, paneFocused]);
  return (
    <button
      ref={ref}
      type="button"
      className="gloom-icon-button"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={ariaKeyShortcut(shortcut)}
      aria-haspopup={hasPopup}
      aria-expanded={expanded}
      title={name}
      disabled={disabled || !onPress}
      data-gloom-interactive={onPress && !disabled ? "true" : undefined}
      data-gloom-role="icon-button"
      data-icon={icon}
      style={color ? { color } : undefined}
      onMouseDown={(event) => { if (stopPropagation) event.stopPropagation(); }}
      onMouseUp={(event) => { if (stopPropagation) event.stopPropagation(); }}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      // Focus from a press draws no ring and names nothing; the keyboard's does both.
      onFocus={focusLabel ? (event) => setKeyboardFocused(event.currentTarget.matches(":focus-visible")) : undefined}
      onBlur={focusLabel ? () => setKeyboardFocused(false) : undefined}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        if (disabled) return;
        const target = event.currentTarget;
        onPress?.(pressEventFrom(target, event.clientX, event.clientY, event));
        releasePointerFocus(target, event.detail);
      }}
      onKeyDown={(event) => {
        // Same activation as the kit Button: the key is consumed here so a
        // pane or table behind the button does not also act on it.
        if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        onPress?.(pressEventFrom(event.currentTarget, bounds.right, bounds.bottom, event));
      }}
    >
      <WebIcon name={icon} size={size} />
      {focusLabel && keyboardFocused ? <IconFocusLabel button={ref} text={name} /> : null}
    </button>
  );
}
