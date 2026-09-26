import { useCallback } from "react";
import { useAsyncResource } from "../../../react/async-resource";
import { type IvStats, loadIvHistory } from "./client";

/** IV30 rank and percentile of the latest stored close; null while loading, uncovered or signed out of Cloud IV. */
export function useIvRank(symbol: string | null | undefined): IvStats | null {
  const normalized = symbol?.trim().toUpperCase() || null;
  const loader = useCallback(async () => (await loadIvHistory(normalized!, { days: 30 })).stats.iv30, [normalized]);
  return useAsyncResource(normalized ? loader : null).data ?? null;
}
