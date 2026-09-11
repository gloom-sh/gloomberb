import type { BrokerContractRef } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";

const MONTH_ABBREV = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Chain timestamps encode an expiry calendar date in UTC, not a local instant. */
export function formatExpDate(ts: number): string {
  const d = new Date(ts * 1000);
  const month = MONTH_ABBREV[d.getUTCMonth()] || String(d.getUTCMonth() + 1);
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${month} ${d.getUTCDate()} '${yy}`;
}

/**
 * Parse IBKR option symbol like "UBER 260821C00090000" into components.
 * Returns null if not a recognized option symbol.
 */
export function parseOptionSymbol(symbol: string): { underlying: string; expTs: number; strike: number; side: "C" | "P" } | null {
  const m = symbol.match(/^(\S+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, underlying, yy, mm, dd, side, rawStrike] = m;
  const strike = parseInt(rawStrike!, 10) / 1000;
  const year = 2000 + parseInt(yy!, 10);
  const month = parseInt(mm!, 10) - 1;
  const day = parseInt(dd!, 10);
  const expTs = Math.floor(Date.UTC(year, month, day) / 1000);
  return { underlying: underlying!, expTs, strike, side: side as "C" | "P" };
}

export interface ResolvedOptionsTarget {
  isOptionTicker: boolean;
  parsedOption: ReturnType<typeof parseOptionSymbol>;
  effectiveTicker: string;
  effectiveExchange: string;
  instrument: BrokerContractRef | null;
  cacheKey: string;
}

function buildOptionsCacheKey(
  effectiveTicker: string,
  effectiveExchange: string,
  instrument: BrokerContractRef | null,
): string {
  return [
    effectiveTicker.trim().toUpperCase(),
    effectiveExchange.trim().toUpperCase(),
    instrument?.brokerInstanceId ?? "",
    instrument?.conId != null ? String(instrument.conId) : "",
  ].join("|");
}

export function resolveOptionsTarget(ticker: TickerRecord | null | undefined): ResolvedOptionsTarget | null {
  if (!ticker) return null;

  const isOptionTicker = ticker.metadata.assetCategory === "OPT";
  const parsedOption = isOptionTicker ? parseOptionSymbol(ticker.metadata.ticker) : null;
  const effectiveTicker = parsedOption?.underlying ?? ticker.metadata.ticker;

  if (!effectiveTicker) return null;

  const effectiveExchange = isOptionTicker ? "" : (ticker.metadata.exchange ?? "");
  const instrument = ticker.metadata.broker_contracts?.[0] ?? null;

  return {
    isOptionTicker,
    parsedOption,
    effectiveTicker,
    effectiveExchange,
    instrument,
    cacheKey: buildOptionsCacheKey(effectiveTicker, effectiveExchange, instrument),
  };
}

/**
 * Format IBKR option symbol like "UBER 260821C00090000" into readable form.
 * e.g. "UBER C $90 Aug'26"
 */
export function formatOptionTicker(symbol: string): string {
  const m = symbol.match(/^(\S+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return symbol;
  const [, underlying, yy, mm, , side, rawStrike] = m;
  const strike = parseInt(rawStrike!, 10) / 1000;
  const month = MONTH_ABBREV[parseInt(mm!, 10) - 1] || mm;
  const strikeStr = strike % 1 === 0 ? String(strike) : strike.toFixed(1);
  return `${underlying} ${side === "C" ? "C" : "P"} $${strikeStr} ${month}'${yy}`;
}
