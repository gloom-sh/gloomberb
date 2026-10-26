import type { BrokerContractRef, TickerListingRef } from "../types/instrument";
import { canonicalExchange } from "./exchanges";
import { optionContractIdentity } from "./options";

const normalized = (value: string | undefined): string => value?.trim().toUpperCase() ?? "";

/** Source-declared contract identity, independent of UI symbols and routing priority. */
export function brokerContractIdentityKey(contract: BrokerContractRef): string {
  if (contract.conId != null) return String(contract.conId);
  // A local symbol alone need not identify the supplied expiry, strike or deliverable.
  // Version this fallback so old symbol-only cache entries cannot supply its prices.
  return `definition-v1:${JSON.stringify([
    normalized(contract.localSymbol), normalized(contract.symbol), normalized(contract.secType),
    normalized(contract.exchange), normalized(contract.primaryExchange), normalized(contract.currency),
    normalized(contract.lastTradeDateOrContractMonth), normalized(contract.right),
    contract.strike == null ? null : Number.isFinite(contract.strike) ? contract.strike : String(contract.strike),
    normalized(contract.multiplier), normalized(contract.tradingClass),
  ])}`;
}

export function scopedBrokerContractIdentityKey(contract: BrokerContractRef): string {
  return JSON.stringify([contract.brokerId, contract.brokerInstanceId ?? "", brokerContractIdentityKey(contract)]);
}

export function instrumentIdentityKey(instrument: {
  symbol: string;
  exchange?: string;
  brokerId?: string;
  brokerInstanceId?: string;
  instrument?: BrokerContractRef | null;
}): string {
  return [
    normalized(instrument.symbol), normalized(instrument.exchange),
    instrument.brokerId ?? "", instrument.brokerInstanceId ?? "",
    instrument.instrument ? brokerContractIdentityKey(instrument.instrument) : "",
  ].join("|");
}

/**
 * Whether two refs name the same contract however a broker routed or filed it: by conId when both
 * have one; an option by its OCC contract; a share by symbol, currency and terms, where SMART names
 * a route and not a listing and an ETF may be filed as a stock, though two named listings must agree;
 * anything else by its definition. Which broker and profile hold it is the caller's to compare.
 */
export function sameBrokerContract(held: BrokerContractRef, contract: BrokerContractRef): boolean {
  if (held.conId !== undefined && contract.conId !== undefined) return held.conId === contract.conId;
  const option = optionContractIdentity(held);
  if (option || optionContractIdentity(contract)) return option === optionContractIdentity(contract)
    && (held.multiplier === undefined || contract.multiplier === undefined || Number(held.multiplier) === Number(contract.multiplier));
  const stock = (value: BrokerContractRef) => !value.secType || ["STK", "ETF"].includes(value.secType.toUpperCase());
  if (stock(held) && stock(contract)) {
    const venue = (value: BrokerContractRef) => [value.exchange, value.primaryExchange].map(canonicalExchange).find((name) => name && name !== "SMART") ?? "";
    const share = (value: BrokerContractRef) => JSON.stringify([value.symbol.toUpperCase(), (value.localSymbol ?? value.symbol).toUpperCase(), value.currency,
      value.lastTradeDateOrContractMonth, value.right, value.strike, value.multiplier]);
    return share(held) === share(contract) && (!venue(held) || !venue(contract) || venue(held) === venue(contract));
  }
  const key = (value: BrokerContractRef) => JSON.stringify([
    value.symbol.toUpperCase(), canonicalExchange(value.exchange), value.secType, value.currency, value.lastTradeDateOrContractMonth,
    value.right, value.strike, value.multiplier, (value.localSymbol ?? value.symbol).toUpperCase(),
  ]);
  return key(held) === key(contract);
}

/**
 * Whether a share a broker holds is one of this listing's, for a pane bound to a listing and no
 * broker contract: in the listing's currency, held through a route (SMART) or on its venue.
 */
export function heldOnListing(held: BrokerContractRef, listing: TickerListingRef): boolean {
  const share = !optionContractIdentity(held) && (!held.secType || ["STK", "ETF"].includes(held.secType.toUpperCase()));
  if (!share || !listing.currency) return false;
  return sameBrokerContract(held, { ...held, conId: undefined, exchange: listing.exchange, primaryExchange: undefined, currency: listing.currency });
}
