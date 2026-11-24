/** Single-cell link glyph: emoji link icons render double-width in terminals. */
export const LINK_GLYPH = "\u29c9";

/**
 * A display title without the note of what the pane follows ("Chart: NVDA" of
 * "Chart: NVDA  \u29c9 Linked to Ticker Research"): what a stack's tab says in
 * a header with no room for the note.
 */
export function paneTitleWithoutLink(title: string): string {
  const at = title.indexOf(`  ${LINK_GLYPH} `);
  return at < 0 ? title : title.slice(0, at);
}
