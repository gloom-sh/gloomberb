import type { PerpEquityListing } from "../../../api-client/perps";
import { listingSuffixExchange } from "../../../sources/listing-symbols";
import { canonicalExchange } from "../../../utils/exchanges";
import { listingIdentity } from "../shared/ticker-request";

/** A qualifier owns the listing. Conflicting metadata cannot authorize a comparison. */
export function perpEquityIdentity(key: string, savedExchange = ""): PerpEquityListing | null {
  const identity = listingIdentity(key, savedExchange);
  if (!identity) return null;
  const suffixExchange = listingSuffixExchange(identity.symbol);
  const exchange = suffixExchange ?? canonicalExchange(identity.exchange);
  if (!exchange || (identity.exchange && canonicalExchange(identity.exchange) !== exchange)
    || (savedExchange && canonicalExchange(savedExchange) !== exchange)) return null;
  const symbol = suffixExchange ? identity.symbol.slice(0, identity.symbol.lastIndexOf(".")) : identity.symbol;
  return /^[A-Z0-9.-]{1,32}$/.test(symbol) ? { symbol, exchange } : null;
}
