/**
 * Box props for what sits under a pane's header zone (tabs, query bar,
 * figures) on the desktop and the web: it takes the space left in its column
 * by flex and ends at the pane footer. The terminal counts the rows left
 * instead; there a bar is one row, but on the desktop a chrome bar is taller
 * than a row (`--chrome-h`), so a body given those rows overruns the pane.
 */
export const FILL_REST = { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 } as const;
