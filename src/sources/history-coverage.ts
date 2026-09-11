import type { PriceHistorySource, PricePoint } from "../types/financials";
import { canonicalExchange } from "../utils/exchanges";

export const SHELL_VERIFIED_LINEAGE_START = "2005-07-21";

/** The issuer's London A-share dataset starts here. Yahoo's preceding current-
 * ticker history contains an unreconciled 1997 discontinuity. Corroborated
 * post-unification samples establish A-share lineage, not every daily price.
 * Do not reconstruct predecessor prices using an assumed split or FX ratio. */
export function applyYahooHistoryCoverage(
  symbol: string,
  metadata: { symbol?: unknown; exchangeName?: unknown; currency?: unknown },
  interval: string,
  points: PricePoint[],
): PricePoint[] {
  if (symbol.toUpperCase() !== "SHEL.L" || /^\d+(m|h)$/i.test(interval)) return points;
  if (metadata.symbol !== "SHEL.L" || typeof metadata.exchangeName !== "string"
    || canonicalExchange(metadata.exchangeName) !== "LSE" || !["GBp", "GBP"].includes(String(metadata.currency))) {
    throw new Error("Shell London history source identity could not be verified");
  }
  const historySource: PriceHistorySource = {
    provider: "yahoo", symbol: "SHEL", exchange: "LSE", currency: "GBP",
    verifiedLineageStart: SHELL_VERIFIED_LINEAGE_START,
  };
  // Yahoo timestamps identify the start of a bar. Drop a whole spanning weekly
  // or monthly bar; retaining its close would leave unreconciled OHLC values.
  const cutoff = Date.parse(SHELL_VERIFIED_LINEAGE_START);
  return points.filter((point) => point.date.getTime() >= cutoff)
    .map((point) => ({ ...point, historySource }));
}
