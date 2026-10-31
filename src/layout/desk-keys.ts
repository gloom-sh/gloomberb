/**
 * The desks offered when the app first runs ("What do you trade most?"). Kept apart
 * from the desk layouts (desks.ts) so chat can name what someone trades
 * without loading every layout. The server keeps the same keys.
 */
export const DESK_KEYS = ["equities", "options", "futures", "rates", "fx", "active"] as const;
export type DeskKey = (typeof DESK_KEYS)[number];

/** The most desks the step takes: the few someone trades most, not one of each. */
export const MAX_DESK_PICKS = 3;
