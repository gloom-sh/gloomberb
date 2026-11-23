import type { TickerRecord } from "../../types/ticker";
import { isUsListingExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { indexRootFor } from "../index-roots";
import { candidateExchange } from "./home-listing";
import { buildTickerSearchCandidates } from "./index";
import type { TickerSearchCandidate } from "./types";

/**
 * A bare index root (SPX, VIX, NDX; `indexRootFor`) with its index leading,
 * as the CLI reads the word: `search spx` names ^SPX before any listing, and
 * `fn SEAS SPX` opens ^SPX. Search lists the listings of those letters
 * (SpaceX's SPX on six German venues) and funds named for the index first, and
 * the index far down or not at all, so the index is added where search did
 * not send it. A US listing or a saved ticker of the letters keeps the lead, as
 * every command keeps it (MOVE is Corvex), with the index right after it. Any
 * other query keeps its order.
 */
export function withIndexRootCandidate(
  query: string,
  candidates: TickerSearchCandidate[],
  tickers: ReadonlyMap<string, TickerRecord>,
): TickerSearchCandidate[] {
  const root = indexRootFor(query);
  if (!root) return candidates;
  const isIndex = (candidate: TickerSearchCandidate) => parsePublicTickerKey(candidate.symbol).symbol === root.symbol;
  const sent = candidates.find(isIndex);
  const [index] = sent ? [sent] : buildTickerSearchCandidates({
    query: root.symbol,
    tickers,
    providerResults: [{ providerId: "gloomberb-cloud", symbol: root.symbol, name: root.name, exchange: "", type: "INDEX" }],
    totalLimit: 1,
    localLimit: 0,
  });
  if (!index) return candidates;
  const rest = candidates.filter((candidate) => !isIndex(candidate));
  const letters = query.trim().toUpperCase();
  const at = rest.findIndex((candidate) => parsePublicTickerKey(candidate.symbol).symbol === letters && !candidate.result?.delisting
    && (candidate.saved || isUsListingExchange(candidateExchange(candidate))));
  return at < 0 ? [index, ...rest] : [...rest.slice(0, at + 1), index, ...rest.slice(at + 1)];
}
