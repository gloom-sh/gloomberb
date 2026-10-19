import { CARD_ACCENT_RULE } from "./card";

/**
 * Desktop and web: the faint tint of the colour a quote or a band belongs to,
 * laid over whatever surface is under it.
 */
export function accentTint(accent = "var(--gloom-accent)") {
  return `color-mix(in srgb, ${accent} 7%, transparent)`;
}

/**
 * Desktop and web: verbatim text from a source (a filing's clause, a
 * disclosure), set apart from what surrounds it by a rule down its left edge
 * in `accent` (the accent when unset) and a faint tint of it, 4px by 12px
 * inside. The text inside keeps its own colour and size.
 */
export function quoteBlockStyle(accent = "var(--gloom-accent)") {
  return {
    borderLeft: `${CARD_ACCENT_RULE} solid ${accent}`,
    background: accentTint(accent),
    padding: "var(--gloom-space-xs) var(--gloom-space-md)",
    boxSizing: "border-box",
  } as const;
}

/**
 * Desktop and web: the same rule laid over the left edge of a block whose rows
 * keep their own backgrounds and insets (a chat announcement, whose rows still
 * take the hover and the selection). The block needs `position: relative`;
 * the rule takes no space and no pointer.
 */
export function accentRuleOverlayStyle(accent = "var(--gloom-accent)") {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: CARD_ACCENT_RULE,
    background: accent,
    pointerEvents: "none",
  } as const;
}
