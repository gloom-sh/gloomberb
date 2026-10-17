/**
 * When in the New York day the US Treasury yields are taken, named beside
 * their dates so two 10-year yields for one day do not read as a
 * contradiction. docs/research-data.md (Cut-off times) explains the difference.
 */

/**
 * Treasury's par curves (GC's UST, TIPS real and breakevens) and FRED's
 * constant-maturity series (DGS10) read from them: bid-side quotes the New
 * York Fed takes near 15:30 ET.
 */
export const TREASURY_CURVE_CUTOFF = "15:30 ET";

/** Cboe's Treasury yield indices (^IRX, ^FVX, ^TNX, ^TYX) stop at their 15:00 ET close. */
export const CBOE_YIELD_INDEX_CLOSE = "15:00 ET";
