import type { TickerInstrumentKind } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";
import { classifyInstrumentType, kindFromListingSyntax } from "./instrument-kind";

/** What a function's covered kinds are called in "INS covers companies only". */
const KIND_PLURALS: Record<TickerInstrumentKind, string> = {
  equity: "companies",
  fund: "funds",
  crypto: "cryptocurrencies",
  currency: "currency pairs",
  index: "indices",
  future: "futures",
  perpetual: "perpetual futures",
  prediction: "prediction markets",
  option: "options",
  bond: "bonds",
  other: "other instruments",
};

/** What one instrument of a kind is, after "is": an index, a currency pair. */
const KIND_NOUNS: Record<TickerInstrumentKind, string> = {
  equity: "a company's stock",
  fund: "a fund",
  crypto: "a cryptocurrency",
  currency: "a currency pair",
  index: "an index",
  future: "a futures contract",
  perpetual: "a perpetual future",
  prediction: "a prediction market",
  option: "an option",
  bond: "a bond",
  other: "not a company",
};

/** A fund named by its own type, which says more than "a fund": an ETF, a mutual fund. */
const FUND_TYPE_NOUNS: Record<string, string> = {
  ETF: "an ETF",
  EXCHANGETRADEDFUND: "an ETF",
  ETN: "an ETN",
  ETP: "an exchange-traded product",
  MUTUALFUND: "a mutual fund",
  MONEYMARKET: "a money-market fund",
  MONEYMARKETFUND: "a money-market fund",
  CEF: "a closed-end fund",
  CLOSEDEND: "a closed-end fund",
  CLOSEDENDFUND: "a closed-end fund",
};

/** An instrument a function was asked about, with what it is. */
export interface InstrumentOfKind {
  /** The listing as typed or resolved: ^VIX, VOO, SAN:EPA. */
  symbol: string;
  kind: TickerInstrumentKind;
  /** The provider's or broker's type (ETF, MUTUALFUND), which names a fund more exactly than its kind. */
  type?: string | null;
}

/**
 * The kind the instrument is not covered as, or null when the function covers
 * it. An instrument nothing classifies (`other`) is let through: only a kind
 * the function's data plainly does not hold (an index for company filings) is
 * answered instead of loaded.
 */
export function uncoveredInstrumentKind(
  covered: readonly TickerInstrumentKind[] | undefined,
  kind: TickerInstrumentKind | null,
): TickerInstrumentKind | null {
  if (!covered?.length || kind == null || kind === "other" || covered.includes(kind)) return null;
  return kind;
}

/** "an index", "an ETF", "a currency pair": what the instrument is, as a sentence names it. */
function instrumentKindNoun({ kind, type }: Pick<InstrumentOfKind, "kind" | "type">): string {
  const fundType = (type ?? "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  return kind === "fund" ? FUND_TYPE_NOUNS[fundType] ?? KIND_NOUNS.fund : KIND_NOUNS[kind];
}

/** "companies", "companies and funds". */
function coveredNoun(covered: readonly TickerInstrumentKind[]): string {
  const nouns = covered.map((kind) => KIND_PLURALS[kind]);
  return nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}` : nouns[0] ?? "";
}

/**
 * What a function that covers only some instruments says of one outside them,
 * in place of an error from its source or an empty report: "INS covers
 * companies only, and ^VIX is an index." `name` is what the reader calls the
 * function: its code (INS), or the pane's name.
 */
export function uncoveredInstrumentMessage(
  name: string,
  covered: readonly TickerInstrumentKind[],
  instrument: InstrumentOfKind,
): string {
  return `${name} covers ${coveredNoun(covered)} only, and ${instrument.symbol} is ${instrumentKindNoun(instrument)}.`;
}

/**
 * What a ticker is without asking for its quote: an index, pair, future or
 * coin by its symbol (^VIX, EURUSD=X), a fund by the type it was saved with
 * (brokers file funds as stocks, so only a kind more specific than a stock
 * counts). Null when neither says; the caller may then read the quote's type.
 */
export function knownInstrumentOfTicker(symbol: string, ticker: TickerRecord | null | undefined): InstrumentOfKind | null {
  const syntax = kindFromListingSyntax(symbol, ticker?.metadata.exchange);
  if (syntax) return { symbol, kind: syntax };
  for (const type of [ticker?.metadata.broker_contracts?.[0]?.secType, ticker?.metadata.assetCategory]) {
    const kind = classifyInstrumentType(type);
    if (kind && kind !== "equity") return { symbol, kind, type };
  }
  return null;
}
