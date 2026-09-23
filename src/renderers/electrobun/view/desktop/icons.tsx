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

export function WebIconButton({
  icon,
  label,
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
      title={label}
      disabled={disabled || !onPress}
      data-gloom-interactive={onPress && !disabled ? "true" : undefined}
      data-gloom-role="icon-button"
      data-icon={icon}
      style={color ? { color } : undefined}
      onMouseDown={(event) => { if (stopPropagation) event.stopPropagation(); }}
      onMouseUp={(event) => { if (stopPropagation) event.stopPropagation(); }}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        if (!disabled) onPress?.();
      }}
    >
      <WebIcon name={icon} size={size} />
    </button>
  );
}
