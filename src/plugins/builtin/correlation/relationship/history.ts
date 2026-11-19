import { useCallback } from "react";
import { ApiRequestError } from "../../../../api-client/errors";
import { useCloudDisplayScope } from "../../../../api-client/plan-access";
import { useAsyncResource } from "../../../../react/async-resource";
import { useAppSelector } from "../../../../state/app/context";
import { useAssetData } from "../../../runtime";
import type { RelationshipRange } from "./model";
import { loadCorrelationHistory } from "../history";

function discardUnavailableHistory(error: unknown) {
  return error instanceof ApiRequestError && [401, 402, 403, 404, 410].includes(error.status ?? 0);
}

export function useRelationshipHistories(pair: [string, string] | null, range: RelationshipRange, forceExchange: string) {
  const dataProvider = useAssetData();
  const tickers = useAppSelector((state) => state.tickers);
  const leftSymbol = pair?.[0] ?? null;
  const rightSymbol = pair?.[1] ?? null;
  const leftExchange = leftSymbol ? tickers.get(leftSymbol)?.metadata.exchange ?? forceExchange : "";
  const rightExchange = rightSymbol ? tickers.get(rightSymbol)?.metadata.exchange ?? "" : "";
  const scope = useCloudDisplayScope();

  const request = useCallback(async (forceRefresh = false) => {
    const results = await Promise.allSettled([leftSymbol!, rightSymbol!].map(async (symbol) => {
      const exchange = symbol === leftSymbol ? leftExchange : rightExchange;
      return {
        symbol,
        points: await loadCorrelationHistory(dataProvider!, symbol, exchange, range,
          forceRefresh ? { cacheMode: "refresh" } : undefined),
      };
    }));
    // A fast transient failure cannot mask a later authoritative denial on the peer.
    const failureIndex = results.findIndex((result) => result.status === "rejected" && discardUnavailableHistory(result.reason));
    const index = failureIndex >= 0 ? failureIndex : results.findIndex((result) => result.status === "rejected");
    const failure = results[index];
    if (failure?.status === "rejected") {
      const symbol = index === 0 ? leftSymbol : rightSymbol;
      const error = failure.reason;
      const message = `${symbol}: ${error instanceof Error ? error.message : String(error)}`;
      throw error instanceof ApiRequestError ? new ApiRequestError(message, error.status, error.retryAfterMs) : new Error(message);
    }
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }, [dataProvider, leftExchange, leftSymbol, range, rightExchange, rightSymbol, scope]);

  const resource = useAsyncResource(leftSymbol && rightSymbol && dataProvider ? request : null, {
    clearOnError: discardUnavailableHistory,
    savedCopy: scope && dataProvider ? { key: ["relationship-history", scope, dataProvider.id, leftSymbol, leftExchange, rightSymbol, rightExchange, range] } : null,
  });
  const error = leftSymbol && rightSymbol && !dataProvider
    ? "Market data unavailable"
    : resource.error;
  return { data: resource.data, loading: resource.loading, error, reload: resource.reload, reloadAndWait: resource.reloadAndWait, updatedAt: resource.updatedAt };
}
