import type { AppState } from "./types";
import { findPaneInstance, type PaneBinding } from "../../../types/config";
import type { BrokerContractRef, TickerListingRef } from "../../../types/instrument";
import type { TickerRecord } from "../../../types/ticker";
import { instrumentFromTicker, type InstrumentRef } from "../../../market-data/request-types";
import { heldOnListing, sameBrokerContract } from "../../../utils/instrument-identity";
import { isBrokerPortfolioId } from "../../../utils/broker-instances";
import { searchContractKey } from "../../../tickers/search/identity";
import { canonicalExchange } from "../../../utils/exchanges";
import { resolveCollectionForPane, resolveTickerForPane } from "./layout";

type InstrumentState = Pick<AppState, "config" | "paneState" | "tickers">;

export function hasAmbiguousTickerContracts(ticker: TickerRecord | null | undefined): boolean {
  return new Set((ticker?.metadata.broker_contracts ?? []).map((brokerContract) => (
    searchContractKey({ brokerContract, type: ticker?.metadata.assetCategory || "" })
  )).filter(Boolean)).size > 1;
}

function fixedSelection(state: InstrumentState, paneId: string, seen = new Set<string>()): Extract<PaneBinding, { kind: "fixed" }> | undefined {
  if (seen.has(paneId)) return undefined;
  seen.add(paneId);
  const pane = findPaneInstance(state.config.layout, paneId);
  if (!pane) return undefined;
  const cursor = state.paneState[paneId]?.cursorSymbol;
  // A row cursor owns its own target, even in a pane with a fixed default.
  if (typeof cursor === "string" && cursor.trim()) return undefined;
  if (pane.binding?.kind === "fixed") return pane.binding;
  return pane.binding?.kind === "follow" ? fixedSelection(state, pane.binding.sourceInstanceId, seen) : undefined;
}

export function resolveListingForPane(state: InstrumentState, paneId: string): TickerListingRef | undefined {
  return fixedSelection(state, paneId)?.listing;
}

/** Resolve the same instrument for a pane, its followers and restored caches. */
export function resolveInstrumentForPane(state: InstrumentState, paneId: string): InstrumentRef | null {
  const symbol = resolveTickerForPane(state as AppState, paneId);
  if (!symbol) return null;
  const ticker = state.tickers.get(symbol);
  const selection = fixedSelection(state, paneId);
  const instrument = selection?.instrument;
  if (instrument === null) return { symbol, exchange: selection?.listing?.exchange || ticker?.metadata.exchange || "", instrument: null };
  if (instrument) return {
    symbol,
    exchange: selection?.listing?.exchange || instrument.exchange || ticker?.metadata.exchange || "",
    brokerId: instrument.brokerId,
    brokerInstanceId: instrument.brokerInstanceId,
    instrument,
  };
  const collectionId = resolveCollectionForPane(state as AppState, paneId);
  const portfolioId = collectionId && (
    isBrokerPortfolioId(collectionId) || state.config.portfolios.some((portfolio) => portfolio.id === collectionId)
    || ticker?.metadata.positions.some((position) => position.portfolio === collectionId)
  ) ? collectionId : undefined;
  if (!portfolioId && hasAmbiguousTickerContracts(ticker)) return null;
  return instrumentFromTicker(ticker, symbol, { portfolioId });
}

/**
 * The listing a contract trades on. A broker's order route (IBKR and Aries
 * send SMART) names no listing, so research, SEC and FINRA lookups and the
 * venue label take the contract's primary exchange, else the saved ticker's
 * own listing in the same currency, else none, which reads the symbol's home
 * listing. Passing SMART on made Cloud treat AAPL as a listing abroad.
 */
function contractListingExchange(ticker: TickerRecord, instrument: BrokerContractRef): string {
  const routed = (exchange?: string) => canonicalExchange(exchange) === "SMART";
  if (instrument.exchange === undefined) return ticker.metadata.exchange;
  if (!routed(instrument.exchange)) return instrument.exchange;
  if (instrument.primaryExchange && !routed(instrument.primaryExchange)) return instrument.primaryExchange;
  const sameCurrency = !instrument.currency || !ticker.metadata.currency || instrument.currency === ticker.metadata.currency;
  return sameCurrency && !routed(ticker.metadata.exchange) ? ticker.metadata.exchange : "";
}

/** A view of one contract, without changing the shared saved ticker record. */
export function tickerForInstrument(ticker: TickerRecord | null, instrument: BrokerContractRef | null | undefined, listing?: TickerListingRef): TickerRecord | null {
  if (!ticker || instrument === undefined) return null;
  if (!instrument && !listing && !ticker.metadata.broker_contracts?.length) return ticker;
  // A position is this contract's however the broker routed it: SPY held through SMART is the ARCX listing's.
  const positions = ticker.metadata.positions.filter((position) => {
    const selected = instrumentFromTicker({ ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, null, { portfolioId: position.portfolio });
    const held = selected?.instrument;
    if (!selected) return false;
    if (!held) return !instrument;
    // A pane opened on a listing from search has no broker contract; a share held there is still its.
    if (!instrument) return !!listing && heldOnListing(held, listing);
    return held.brokerId === instrument.brokerId && (held.brokerInstanceId ?? "") === (instrument.brokerInstanceId ?? "") && sameBrokerContract(held, instrument);
  });
  return { ...ticker, metadata: {
    ...ticker.metadata,
    name: listing?.name ?? ticker.metadata.name,
    exchange: listing?.exchange ?? (instrument ? contractListingExchange(ticker, instrument) : ticker.metadata.exchange),
    currency: listing?.currency ?? instrument?.currency ?? (listing ? "" : ticker.metadata.currency),
    assetCategory: listing?.type ?? instrument?.secType ?? ticker.metadata.assetCategory,
    broker_contracts: instrument ? [instrument] : [],
    positions,
  } };
}
