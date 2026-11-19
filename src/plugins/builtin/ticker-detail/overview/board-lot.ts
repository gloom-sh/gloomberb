import { useCallback } from "react";
import { useAsyncResource } from "../../../../react/async-resource";
import { listingBoardLot, statesBoardLot } from "../../../../market-data/ah-pair";
import { useAssetData } from "../../../runtime";

/**
 * The shares one lot of an HKEX or SGX listing trades in, from its company's
 * listings as Gloom Cloud holds them (`getIssuerListings`, the read an A+H
 * line's DES already makes); null for a listing elsewhere, while it loads, or
 * when none is stated.
 */
export function useListingBoardLot(symbol: string | null | undefined, exchange: string | null | undefined): number | null {
  const dataProvider = useAssetData();
  const reads = statesBoardLot(symbol, exchange) && !!dataProvider?.getIssuerListings;
  const loader = useCallback(
    () => dataProvider!.getIssuerListings!(symbol!, exchange ?? undefined),
    [dataProvider, exchange, symbol],
  );
  const issuer = useAsyncResource(reads ? loader : null);
  return reads && symbol ? listingBoardLot(issuer.data, symbol, exchange) : null;
}
