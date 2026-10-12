import type { TickerFinancials } from "../types/financials";
import type { TickerInstrumentKind } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import { perpetualListing } from "./perpetual-listing";

const KIND_BY_TYPE: Record<string, TickerInstrumentKind> = {
  STK: "equity",
  STOCK: "equity",
  EQUITY: "equity",
  COMMONSTOCK: "equity",
  ADR: "equity",
  DEPOSITARYRECEIPT: "equity",
  AMERICANDEPOSITARYRECEIPT: "equity",
  GLOBALDEPOSITARYRECEIPT: "equity",
  LIMITEDPARTNERSHIP: "equity",
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
  PERP: "perpetual",
  PERPETUAL: "perpetual",
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

function normalizeInstrumentType(type: string | null | undefined): string {
  return (type ?? "").trim().toUpperCase().replace(/[\s_-]+/g, "");
}

/** A provider or broker type string, or null when it names nothing known. */
export function classifyInstrumentType(type: string | null | undefined): TickerInstrumentKind | null {
  const normalized = normalizeInstrumentType(type);
  if (!normalized) return null;
  const exact = KIND_BY_TYPE[normalized];
  if (exact) return exact;
  if (normalized.includes("CRYPTO")) return "crypto";
  if (normalized.includes("ETF") || normalized.includes("FUND")) return "fund";
  if (normalized.includes("FOREX") || normalized.includes("CURRENCY")) return "currency";
  return null;
}

/** Market listing syntax: `CCC` coins, a perpetual venue's contracts, `^` indices, `=X` pairs, `=F` futures. */
export function kindFromListingSyntax(listing: string, exchange?: string): TickerInstrumentKind | null {
  if (canonicalExchange(exchange) === "CCC") return "crypto";
  if (perpetualListing(listing, exchange)) return "perpetual";
  const symbol = parsePublicTickerKey(listing).symbol;
  if (symbol.startsWith("^")) return "index";
  if (symbol.endsWith("=X")) return "currency";
  if (symbol.endsWith("=F")) return "future";
  return null;
}

function kindFromListing(ticker: TickerRecord | null | undefined): TickerInstrumentKind | null {
  return ticker ? kindFromListingSyntax(ticker.metadata.ticker, ticker.metadata.exchange) : null;
}

function instrumentTypes(
  ticker: TickerRecord | null | undefined,
  financials?: Pick<TickerFinancials, "quote" | "quoteMetadata"> | null,
) {
  return [
    financials?.quote?.instrumentType,
    financials?.quoteMetadata?.instrumentType,
    ticker?.metadata.broker_contracts?.[0]?.secType,
    ticker?.metadata.assetCategory,
  ];
}

/**
 * Explicit mutual-fund and money-market shares have neither listed options nor
 * 13F-reportable ownership. Use the kind resolver's type precedence; generic
 * funds, ETFs and closed-end funds stay eligible.
 */
export function isKnownMutualFund(
  ticker: TickerRecord | null | undefined,
  financials?: Pick<TickerFinancials, "quote" | "quoteMetadata"> | null,
): boolean {
  const type = instrumentTypes(ticker, financials).find((candidate) => {
    const kind = classifyInstrumentType(candidate);
    return kind !== null && kind !== "equity";
  });
  return ["MUTUALFUND", "MONEYMARKET", "MONEYMARKETFUND"].includes(normalizeInstrumentType(type));
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
  const typed = instrumentTypes(ticker, financials).map(classifyInstrumentType);
  return typed.find((kind) => kind !== null && kind !== "equity")
    ?? kindFromListing(ticker)
    ?? "equity";
}

/**
 * A coin-typed listing named "<asset> (Derivatives)", such as NATGAS-USD
 * "Natural Gas (Derivatives) USD": the price perpetual futures on that asset
 * trade at on crypto venues, around the clock. It is neither the asset's
 * exchange-listed future nor its spot price, though its type reads as a coin.
 */
export function isCryptoVenuePerpetual(type: string | null | undefined, name: string | null | undefined): boolean {
  return classifyInstrumentType(type) === "crypto" && /\(derivatives\)/i.test(name ?? "");
}

/**
 * A listing's type, in plain words where the provider's type misleads (a
 * perpetual typed as a coin). `detail` says what it is not, for a report line.
 */
export function instrumentTypeLabel(
  type: string | null | undefined,
  name: string | null | undefined,
  options: { detail?: boolean } = {},
): string | undefined {
  if (isCryptoVenuePerpetual(type, name)) {
    return options.detail ? "Perpetual futures price (24/7 on crypto venues; not the listed future, not spot)" : "Perpetual futures price";
  }
  if (classifyInstrumentType(type) === "perpetual") return "Perpetual futures";
  return type?.trim() || undefined;
}
