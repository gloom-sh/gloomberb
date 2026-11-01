/**
 * What a ticker search's rows do, carried by its route (and by a launch request that opens one).
 * Without one, Enter changes the focused pane's ticker (`layout/ticker-retarget.ts`).
 */
export type TickerSearchPayload = Readonly<Record<string, unknown>>;

/**
 * The ticker search DES opens: its rows open DES. So does every search that opens on a ticker
 * rather than on a pane: plain `DES`, the listings of an ambiguous open, remote control's ticker
 * mode. Only the backtick and a pane header's ticker search for the focused pane.
 */
export const SECURITY_DESCRIPTION_SEARCH: TickerSearchPayload = { action: "security-description" };
