import type { InstrumentRef } from "../../../market-data/request-types";
import type { TickerRecord } from "../../../types/ticker";
import { canonicalExchange } from "../../../utils/exchanges";
import { VCA_LIMIT, VCA_PRESETS, type VcaPreset } from "./model";

const US_VENUES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "CBOE", "NYSEARCA", "NYSEAMERICAN"]);
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const PRESET_LABELS: Record<VcaPreset, string> = { etfs: "Index and sector ETFs", megacaps: "US mega caps" };

export interface VcaUniverse { label: string; instruments: InstrumentRef[]; error: string | null }

/** Stored IV covers US-listed option underlyings; other listings are left out rather than queued. */
function usListed(ticker: Pick<TickerRecord, "metadata">): boolean {
  const exchange = canonicalExchange(ticker.metadata.exchange);
  return US_VENUES.has(exchange) || (!exchange && ticker.metadata.currency === "USD");
}

export function vcaUniverse(scope: string, symbolsText: string, collectionId: string | null | undefined,
  tickers: readonly Pick<TickerRecord, "metadata">[]): VcaUniverse {
  let label: string, instruments: InstrumentRef[], skipped = 0;
  if (scope === "custom") {
    label = "Custom symbols";
    instruments = symbolsText.split(/[\s,]+/).map((value) => value.split(":")).filter(([symbol]) => !!symbol)
      .map(([symbol, exchange]) => ({ symbol: symbol!.toUpperCase(), exchange: (exchange ?? "").toUpperCase() }));
  } else if (scope === "collection") {
    label = "Linked collection";
    const members = tickers.filter((ticker) => collectionId && [...ticker.metadata.watchlists, ...ticker.metadata.portfolios].includes(collectionId));
    instruments = members.filter(usListed).map((ticker) => ({ symbol: ticker.metadata.ticker.toUpperCase(), exchange: ticker.metadata.exchange }));
    skipped = members.length - instruments.length;
  } else {
    const preset: VcaPreset = scope === "megacaps" ? "megacaps" : "etfs";
    label = PRESET_LABELS[preset];
    instruments = VCA_PRESETS[preset].map((symbol) => ({ symbol, exchange: "" }));
  }
  const valid = [...new Map(instruments.filter((instrument) => SYMBOL.test(instrument.symbol)).map((instrument) => [instrument.symbol, instrument])).values()];
  const error = !valid.length ? scope === "collection" ? "Link a watchlist or portfolio with US-listed symbols in pane settings." : "Add symbols in pane settings."
    : valid.length > VCA_LIMIT ? `Showing the first ${VCA_LIMIT} of ${valid.length} symbols.`
      : skipped ? `${skipped} non-US listing${skipped === 1 ? "" : "s"} left out: stored implied volatility covers US option underlyings.` : null;
  return { label, instruments: valid.slice(0, VCA_LIMIT), error };
}
