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

/** `UBER 260821C00090000` as a broker writes it, or `AAPL261218C00300000` as OCC does and Gloom Cloud serves it. */
const OPTION_CONTRACT = /^(\S+?)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** A strike as a person writes it: 300, 12.5, 12.75; the symbol holds it in thousandths. */
function formatOptionStrike(strike: number): string {
  return String(Number(strike.toFixed(3)));
}

/** A contract's parts from an OCC symbol, spaced or compact; null for anything else, including a date that does not exist. */
function parseOptionContract(symbol: string): { underlying: string; year: number; month: number; day: number; side: "C" | "P"; strike: number } | null {
  const match = OPTION_CONTRACT.exec(symbol.trim());
  if (!match) return null;
  const [, underlying, yy, mm, dd, side, rawStrike] = match;
  const year = 2000 + parseInt(yy!, 10);
  const month = parseInt(mm!, 10);
  const day = parseInt(dd!, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { underlying: underlying!, year, month, day, side: side as "C" | "P", strike: parseInt(rawStrike!, 10) / 1000 };
}

/**
 * Format an option symbol like "UBER 260821C00090000" or "UBER260821C00090000" into readable form.
 * e.g. "UBER C $90 Aug'26"
 */
export function formatOptionTicker(symbol: string): string {
  const contract = parseOptionContract(symbol);
  if (!contract) return symbol;
  const month = MONTH_ABBREV[contract.month - 1]!;
  return `${contract.underlying} ${contract.side} $${formatOptionStrike(contract.strike)} ${month}'${String(contract.year).slice(2)}`;
}

/**
 * The name of an option contract written out: underlying, expiry day, strike and side, as the options chain
 * dates it. "AAPL Dec 18 '26 $300 Call" for AAPL261218C00300000; null when the symbol is not a contract.
 */
export function optionContractName(symbol: string): string | null {
  const contract = parseOptionContract(symbol);
  if (!contract) return null;
  const expiry = formatExpDate(Date.UTC(contract.year, contract.month - 1, contract.day) / 1000);
  return `${contract.underlying} ${expiry} $${formatOptionStrike(contract.strike)} ${contract.side === "C" ? "Call" : "Put"}`;
}
