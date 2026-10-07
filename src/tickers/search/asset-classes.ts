import { classifyInstrumentType, kindFromListingSyntax } from "../instrument-kind";
import type { TickerSearchInstrumentClass } from "./types";

/**
 * Class codes typed after a symbol or name, the way a terminal's market
 * sector key follows a ticker: `ES FUT`, `EURUSD CUR`, `BTC CRYP`, `SPY ETF`.
 * The same letters are the badge on a matching search row, so the list teaches
 * them. A code on its own is never a filter: `EQ` is still Equillium, and
 * `FUT`, `ETF` and `CRYP` still open their panes.
 */
const ASSET_CLASS_CODES = ["EQ", "CUR", "CRYP", "OPT", "FUT", "IDX", "ETF", "FUND"] as const;

export type AssetClassCode = (typeof ASSET_CLASS_CODES)[number];

/**
 * Whether a query's code keeps a row badged `rowCode`. CUR keeps coins and
 * FUND keeps exchange-traded funds as well: `BTC CUR` is the coin, as the
 * market sector key files it, and a fund name typed in full ends in "Fund"
 * whether or not the fund trades on an exchange (Technology Select Sector
 * SPDR Fund is XLK).
 */
export function assetClassKeeps(code: AssetClassCode, rowCode: AssetClassCode | null): boolean {
  if (rowCode === code) return true;
  return (code === "CUR" && rowCode === "CRYP") || (code === "FUND" && rowCode === "ETF");
}

export interface AssetClassQuery {
  code: AssetClassCode;
  /** The symbol or name typed before the code. */
  symbolQuery: string;
}

function isAssetClassCode(value: string): value is AssetClassCode {
  return (ASSET_CLASS_CODES as readonly string[]).includes(value);
}

/** The class a query ends with, when something comes before it. */
export function parseAssetClassQuery(query: string): AssetClassQuery | null {
  const tokens = query.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const code = tokens.at(-1)!.toUpperCase();
  if (!isAssetClassCode(code)) return null;
  return { code, symbolQuery: tokens.slice(0, -1).join(" ") };
}

/**
 * The market spelling a class gives a bare symbol: the catalogue answers `ES`
 * with Eversource only, and `ES=F` with the E-mini future.
 */
export function assetClassMarketSymbol(query: AssetClassQuery): string | null {
  const symbol = query.symbolQuery.toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return null;
  switch (query.code) {
    case "FUT":
      return `${symbol}=F`;
    case "IDX":
      return `^${symbol}`;
    case "CUR":
      return /^[A-Z]{6}$/.test(symbol) ? `${symbol}=X` : `${symbol}-USD`;
    case "CRYP":
      return `${symbol}-USD`;
    default:
      return null;
  }
}

function isExchangeTradedType(type: string): boolean {
  const compact = type.toUpperCase().replace(/[^A-Z]/g, "");
  return /\bET[FNP]\b/i.test(type) || compact.startsWith("EXCHANGETRADED");
}

/**
 * The class code of a search row: its type when the type names one, else its
 * listing syntax (`=F`, `=X`, `^`, the crypto venue). A fund is ETF when it
 * trades on an exchange and FUND otherwise.
 */
export function instrumentClassCode(item: {
  instrumentClass?: TickerSearchInstrumentClass;
  instrumentType?: string | null;
  symbol: string;
  exchange?: string | null;
}): AssetClassCode | null {
  const type = item.instrumentType ?? "";
  const kind = classifyInstrumentType(type) ?? kindFromListingSyntax(item.symbol, item.exchange ?? undefined);
  switch (kind) {
    case "equity":
      return "EQ";
    case "currency":
      return "CUR";
    case "crypto":
      return "CRYP";
    case "option":
      return "OPT";
    case "future":
      return "FUT";
    case "index":
      return "IDX";
    case "fund":
      return isExchangeTradedType(type) ? "ETF" : "FUND";
    case "bond":
    case "other":
      return null;
    default:
      return item.instrumentClass === "equity" ? "EQ" : null;
  }
}
