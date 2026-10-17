import type { ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import { Box, useUiCapabilities } from "../../ui";

export interface CardProps {
  children?: ReactNode;
  /**
   * A colour the card belongs to (a relationship's role, a series): a 2px
   * rule down its left edge and the raised fill tinted toward it.
   */
  accent?: string;
  /** Width in cells (terminal) or any Box width. */
  width?: number | `${number}%`;
  /** The card is the chosen one: an accent border. */
  selected?: boolean;
  /** Makes the whole card a control: it takes the hover fill and the pointer. */
  onPress?: () => void;
}

/**
 * The card's look on the desktop and the web, for a card that has to be its
 * own positioned box (a node in a diagram): the same surface Card draws.
 */
export function cardSurfaceStyle({ selected = false, accent, padding = "var(--gloom-space-sm)" }: {
  selected?: boolean;
  accent?: string;
  /** A card laid out in rows of its own (a diagram node) keeps them: "0 var(--gloom-space-sm)". */
  padding?: string;
} = {}) {
  return {
    background: accent ? `color-mix(in srgb, var(--gloom-surface-raised) 88%, ${accent})` : "var(--gloom-surface-raised)",
    // The frame is drawn inside the box, so a card keeps the size it was given.
    boxShadow: `inset 0 0 0 1px ${selected ? "var(--gloom-accent)" : "var(--gloom-hairline)"}`,
    ...(accent ? { borderLeft: `${CARD_ACCENT_RULE} solid ${accent}` } : {}),
    borderRadius: "var(--gloom-radius-md)",
    padding,
    boxSizing: "border-box",
  } as const;
}

/** The accent rule of a card or a quote: one width for every rule that says what a block belongs to. */
export const CARD_ACCENT_RULE = "2px";

/**
 * A raised box of related content (a quote tile, a flow step). On the desktop
 * and the web: the raised surface, a 1px hairline, the control radius and the
 * pane's 8px inside; chosen, an accent border. The terminal draws a single
 * line frame. Use it for content that is a unit of its own; rows, tables and
 * key-value rows never need one.
 */
export function Card({ children, width, selected = false, accent, onPress }: CardProps) {
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
      style={cardSurfaceStyle({ selected, accent })}
    >
      {children}
    </Box>
  );
}
