/**
 * Spread on the root of a surface that takes its pane's whole box (a chart,
 * a heat map). When that root is the pane's root, the desktop renderer sizes
 * it to the pane's content box by CSS (`PANE_FILL_SELECTOR`, styles.css)
 * whatever cells it was given, so it follows every frame of a resize and fills
 * the last fraction of a cell at rest. The terminal ignores it.
 */
export const PANE_FILL = { "data-gloom-pane-fill": "true" } as const;

/** The pane roots the desktop renderer fills; styles.css carries the same selector. */
export const PANE_FILL_SELECTOR = "[data-gloom-role=\"pane-content\"] > [data-gloom-pane-fill]:only-child";
