/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { IconButtonProps, IconName, IconProps } from "../../../../components/ui/icon";

/** The desktop icon set, drawn on a 12-unit grid in the current colour. */
const ICONS: Record<IconName, ReactNode> = {
  more: (
    <>
      <circle cx="2" cy="6" r="1.1" fill="currentColor" />
      <circle cx="6" cy="6" r="1.1" fill="currentColor" />
      <circle cx="10" cy="6" r="1.1" fill="currentColor" />
    </>
  ),
  close: <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  zap: <path d="M7.1 1.2 2.7 6.5h3.1l-.7 4.3 4.4-5.5H6.4l.7-4.1Z" fill="currentColor" />,
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
  restore: (
    <>
      <rect x="2" y="4" width="6" height="6" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 4V2.8A.8.8 0 0 1 4.8 2H9.2a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H8" stroke="currentColor" strokeWidth="1.1" />
    </>
  ),
};

export function WebIcon({ name, size = 12, color }: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      data-gloom-icon={name}
      style={{ flex: "none", display: "block", color }}
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

export function WebIconButton({
  icon,
  label,
  title,
  shortcut,
  hasPopup,
  onPress,
  pressed,
  color,
  disabled = false,
  size = 12,
  stopPropagation = true,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="gloom-icon-button"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      aria-haspopup={hasPopup}
      title={title ?? label}
      disabled={disabled || !onPress}
      data-gloom-interactive={onPress && !disabled ? "true" : undefined}
      data-gloom-role="icon-button"
      data-icon={icon}
      style={color ? { color } : undefined}
      onMouseDown={(event) => { if (stopPropagation) event.stopPropagation(); }}
      onMouseUp={(event) => { if (stopPropagation) event.stopPropagation(); }}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        if (disabled) return;
        onPress?.(pressEventFrom(event.currentTarget, event.clientX, event.clientY, event));
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
    </button>
  );
}
