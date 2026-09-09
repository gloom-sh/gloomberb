import { useCallback } from "react";
import { useAsyncResource } from "../../../../react/async-resource";
import { useAppSelector } from "../../../../state/app/context";
import type { PricePoint } from "../../../../types/financials";
import { useAssetData } from "../../../runtime";
import type { RelationshipRange } from "./model";

type RelationshipHistoryEntry = {
  symbol: string;
  points: PricePoint[];
  error: string | null;
};

export function useRelationshipHistories(pair: [string, string] | null, range: RelationshipRange, forceExchange: string) {
  const dataProvider = useAssetData();
  const tickers = useAppSelector((state) => state.tickers);
  const leftSymbol = pair?.[0] ?? null;
  const rightSymbol = pair?.[1] ?? null;

  const request = useCallback((forceRefresh = false) => {
    return Promise.all([leftSymbol!, rightSymbol!].map(async (symbol) => {
      const exchange = tickers.get(symbol)?.metadata.exchange ?? (symbol === leftSymbol ? forceExchange : "");
      try {
        return {
          symbol,
          points: await dataProvider!.getPriceHistory(
            symbol,
            exchange,
            range,
            forceRefresh ? { cacheMode: "refresh" } : undefined,
          ),
          error: null,
        };
      } catch (error) {
        return {
          symbol,
          points: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  }, [dataProvider, forceExchange, leftSymbol, range, rightSymbol, tickers]);

  const resource = useAsyncResource(leftSymbol && rightSymbol && dataProvider ? request : null);
  const error = leftSymbol && rightSymbol && !dataProvider
    ? "Market data unavailable"
    : resource.error ?? resource.data?.find((entry) => entry.error)?.error ?? null;
  return { data: resource.data, loading: resource.loading, error, reload: resource.reload };
}
