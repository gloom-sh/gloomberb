import { useCallback } from "react";
import { useAsyncResource } from "../../../../react/async-resource";
import { useAssetData } from "../../../runtime";

export function useIssuerListings(symbol: string | null | undefined, exchange?: string | null, related = false) {
  const provider = useAssetData();
  const read = useCallback(() => provider!.getIssuerListings!(symbol!, exchange ?? undefined, { related }), [provider, symbol, exchange, related]);
  return useAsyncResource(symbol && provider?.getIssuerListings ? read : null).data;
}
