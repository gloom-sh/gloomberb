import type { ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import { Box, useUiCapabilities } from "../../ui";

export interface CardProps {
  children?: ReactNode;
  /** Width in cells (terminal) or any Box width. */
  width?: number | `${number}%`;
  /** The card is the chosen one: an accent border. */
  selected?: boolean;
  /** Makes the whole card a control: it takes the hover fill and the pointer. */
  onPress?: () => void;
}

/**
 * A raised box of related content (a quote tile, a flow step). On the desktop
 * and the web: the raised surface, a 1px hairline, the control radius and the
 * pane's 8px inside; chosen, an accent border. The terminal draws a single
 * line frame. Use it for content that is a unit of its own; rows, tables and
 * key-value rows never need one.
 */
export function Card({ children, width, selected = false, onPress }: CardProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (!nativePaneChrome) {
    return (
      <Box flexDirection="column" width={width} border borderStyle="single" borderColor={selected ? colors.borderFocused : colors.border} onMouseDown={onPress}>
        {children}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={width}
      onMouseDown={onPress}
      data-gloom-ui="card"
      data-gloom-interactive={onPress ? "true" : undefined}
      hoverBackgroundColor={onPress ? "color-mix(in srgb, var(--gloom-surface-raised) 92%, var(--gloom-text-bright))" : undefined}
      data-selected={selected ? "true" : undefined}
      style={{
        background: "var(--gloom-surface-raised)",
        border: `1px solid ${selected ? "var(--gloom-accent)" : "var(--gloom-hairline)"}`,
        borderRadius: "var(--gloom-radius-md)",
        padding: "var(--gloom-space-sm)",
        boxSizing: "border-box",
      }}
    >
      {children}
    </Box>
  );
}
