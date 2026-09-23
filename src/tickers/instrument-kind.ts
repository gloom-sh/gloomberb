import type { TickerFinancials } from "../types/financials";
import type { TickerInstrumentKind } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";

const KIND_BY_TYPE: Record<string, TickerInstrumentKind> = {
  STK: "equity",
  STOCK: "equity",
  EQUITY: "equity",
  COMMONSTOCK: "equity",
  ADR: "equity",
  DEPOSITARYRECEIPT: "equity",
  REIT: "equity",
  PREFERREDSTOCK: "equity",
  ETF: "fund",
  ETN: "fund",
  ETP: "fund",
  FUND: "fund",
  MUTUALFUND: "fund",
  CEF: "fund",
  CLOSEDEND: "fund",
  CLOSEDENDFUND: "fund",
  EXCHANGETRADEDFUND: "fund",
  MONEYMARKET: "fund",
  CRYPTO: "crypto",
  CRYPTOCURRENCY: "crypto",
  DIGITALCURRENCY: "crypto",
  COIN: "crypto",
  TOKEN: "crypto",
  CASH: "currency",
  FX: "currency",
  FOREX: "currency",
  CCY: "currency",
  CURRENCY: "currency",
  CURRENCYPAIR: "currency",
  IND: "index",
  INDEX: "index",
  IDX: "index",
  FUT: "future",
  FUTURE: "future",
  FUTURES: "future",
  CONTFUT: "future",
  OPT: "option",
  OPTION: "option",
  OPTIONS: "option",
  FOP: "option",
  BOND: "bond",
  BILL: "bond",
  FIXEDINCOME: "bond",
  WAR: "other",
  WARRANT: "other",
  CFD: "other",
  CMDTY: "other",
};

/** A provider or broker type string, or null when it names nothing known. */
function classifyInstrumentType(type: string | null | undefined): TickerInstrumentKind | null {
  const normalized = (type ?? "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (!normalized) return null;
  const exact = KIND_BY_TYPE[normalized];
  if (exact) return exact;
  if (normalized.includes("CRYPTO")) return "crypto";
  if (normalized.includes("ETF") || normalized.includes("FUND")) return "fund";
  if (normalized.includes("FOREX") || normalized.includes("CURRENCY")) return "currency";
  return null;
}

/** Yahoo-style listing syntax: `CCC` coins, `^` indices, `=X` pairs, `=F` futures. */
function kindFromListing(ticker: TickerRecord | null | undefined): TickerInstrumentKind | null {
  if (!ticker) return null;
  if (canonicalExchange(ticker.metadata.exchange) === "CCC") return "crypto";
  const symbol = parsePublicTickerKey(ticker.metadata.ticker).symbol;
  if (symbol.startsWith("^")) return "index";
  if (symbol.endsWith("=X")) return "currency";
  if (symbol.endsWith("=F")) return "future";
  return null;
}

/**
 * The ticker's instrument kind from its quote, broker contract, saved type and
 * listing syntax. Brokers file funds and stocks under one generic type (`STK`),
 * so a specific kind from any source outranks a generic equity type from a
 * higher-priority one. A ticker nothing classifies resolves to equity, the
 * common case for a bare symbol.
 */
export function resolveTickerInstrumentKind(
  ticker: TickerRecord | null | undefined,
  financials?: Pick<TickerFinancials, "quote" | "quoteMetadata"> | null,
): TickerInstrumentKind {
  const typed = [
    financials?.quote?.instrumentType,
    financials?.quoteMetadata?.instrumentType,
    ticker?.metadata.broker_contracts?.[0]?.secType,
    ticker?.metadata.assetCategory,
  ].map(classifyInstrumentType);
  return typed.find((kind) => kind !== null && kind !== "equity")
    ?? kindFromListing(ticker)
    ?? "equity";
}
