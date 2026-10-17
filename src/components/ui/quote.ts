import { CARD_ACCENT_RULE } from "./card";

/**
 * Desktop and web: verbatim text from a source (a filing's clause, a
 * disclosure), set apart from what surrounds it by a rule down its left edge
 * in `accent` (the accent when unset) and a faint tint of it, 4px by 12px
 * inside. The text inside keeps its own colour and size.
 */
export function quoteBlockStyle(accent = "var(--gloom-accent)") {
  return {
    borderLeft: `${CARD_ACCENT_RULE} solid ${accent}`,
    background: `color-mix(in srgb, ${accent} 7%, transparent)`,
    padding: "var(--gloom-space-xs) var(--gloom-space-md)",
    boxSizing: "border-box",
  } as const;
}
