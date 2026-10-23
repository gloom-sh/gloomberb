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
 * A strike as every options pane writes it: grouped, with every listed
 * decimal (`82,000`, `82.5`). 15 significant digits keep every listed decimal
 * but drop binary noise from computed strikes such as spot * 0.9.
 */
export function formatStrikeLabel(strike: number): string {
  return Number.isFinite(strike)
    ? strike.toLocaleString("en-US", { maximumSignificantDigits: 15 }) : "\u2014";
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

/** An option ticker's contract as a broker writes it ("UBER 260821C00090000") or as OCC does ("AAPL261218C00300000"). */
export function parseOptionTicker(symbol: string): ReturnType<typeof parseOptionSymbol> {
  const contract = parseOptionContract(symbol);
  if (!contract) return null;
  return { underlying: contract.underlying, expTs: Math.floor(Date.UTC(contract.year, contract.month - 1, contract.day) / 1000),
    strike: contract.strike, side: contract.side };
}

/**
 * One contract of a chain, on the broker that served it: the underlying's
 * broker and profile, with the expiry, side, strike and 100-share deliverable
 * the symbol carries. Null when the underlying is not a broker's or the
 * symbol is not a contract, and the contract then opens by its symbol alone.
 */
export function chainOptionContract(contractSymbol: string, underlying: BrokerContractRef | null | undefined, currency: string): BrokerContractRef | null {
  const contract = parseOptionContract(contractSymbol);
  if (!contract || !underlying?.brokerId) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    brokerId: underlying.brokerId,
    ...(underlying.brokerInstanceId ? { brokerInstanceId: underlying.brokerInstanceId } : {}),
    symbol: contract.underlying,
    localSymbol: contractSymbol.trim().toUpperCase(),
    secType: "OPT",
    currency: currency || underlying.currency || "USD",
    lastTradeDateOrContractMonth: `${contract.year}${pad(contract.month)}${pad(contract.day)}`,
    right: contract.side,
    strike: contract.strike,
    multiplier: "100",
  };
}

/**
 * The OCC identity of an option contract, from its symbol or its fields,
 * however a broker writes the date or routes it; null for anything else.
 */
export function optionContractIdentity(contract: BrokerContractRef): string | null {
  if (contract.secType?.toUpperCase() !== "OPT" && contract.secType?.toUpperCase() !== "OPTION") return null;
  const parsed = parseOptionContract(contract.localSymbol ?? "") ?? parseOptionContract(contract.symbol);
  if (parsed) return `${parsed.underlying}|${parsed.year}${String(parsed.month).padStart(2, "0")}${String(parsed.day).padStart(2, "0")}|${parsed.side}|${parsed.strike}`;
  const date = contract.lastTradeDateOrContractMonth?.replace(/\D/g, "");
  if (!date || date.length !== 8 || !contract.right || contract.strike === undefined) return null;
  return `${contract.symbol.trim().toUpperCase()}|${date}|${contract.right}|${contract.strike}`;
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
  const parsedOption = isOptionTicker ? parseOptionTicker(ticker.metadata.ticker) : null;
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
