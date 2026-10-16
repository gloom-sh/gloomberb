import type { DataProvider } from "../../../types/data-provider";
import type { TickerInstrumentKind } from "../../../types/instrument";
import { classifyInstrumentType, kindFromListingSyntax } from "../../../tickers/instrument-kind";

/** What a stock to try is, in the hint: a name that reports earnings. */
const EXAMPLE = "AAPL";

/** How each instrument kind that reports no earnings is named, and what it is called in the plural. */
const NO_EARNINGS: Partial<Record<TickerInstrumentKind, { one: string; many: string }>> = {
  fund: { one: "a fund", many: "funds" },
  index: { one: "an index", many: "indexes" },
  currency: { one: "a currency pair", many: "currency pairs" },
  crypto: { one: "a cryptocurrency", many: "cryptocurrencies" },
  future: { one: "a future", many: "futures" },
  perpetual: { one: "a perpetual future", many: "perpetual futures" },
};

/** An ETF or ETN is named as itself rather than as a fund. */
function wrappedFund(type: string | null | undefined): { one: string; many: string } | null {
  const word = (type ?? "").trim().toUpperCase();
  return word === "ETF" || word === "ETN" ? { one: `an ${word}`, many: `${word}s` } : null;
}

/** Where the sentence is read: `fn` types `fn ERN AAPL`, the app's command bar `ERN AAPL`. */
export type NoEarningsSurface = "cli" | "pane";

/**
 * Why a symbol has no earnings, when its type is one that never reports any:
 * `SPY is an ETF; ETFs have no earnings. Try `fn ERN AAPL`.` in `fn`, and in
 * the pane and its capture `... Try ERN AAPL.` (no CLI syntax or backticks in
 * the app). Null for a stock or a type nothing classifies, whose empty history
 * is only that nothing is on record yet.
 */
export function noEarningsText(symbol: string, instrumentType: string | null | undefined, surface: NoEarningsSurface): string | null {
  const kind = classifyInstrumentType(instrumentType) ?? kindFromListingSyntax(symbol);
  const name = kind ? wrappedFund(instrumentType) ?? NO_EARNINGS[kind] : null;
  const command = surface === "cli" ? `\`fn ERN ${EXAMPLE}\`` : `ERN ${EXAMPLE}`;
  return name ? `${symbol} is ${name.one}; ${name.many} have no earnings. Try ${command}.` : null;
}

/** `noEarningsText` for a symbol whose type is read from its quote; its listing syntax (`^GSPC`, `CL=F`) answers when the quote cannot. */
export async function loadNoEarningsText(
  provider: Pick<DataProvider, "getQuote">,
  symbol: string,
  surface: NoEarningsSurface,
): Promise<string | null> {
  try {
    return noEarningsText(symbol, (await provider.getQuote(symbol, "")).instrumentType, surface);
  } catch {
    return noEarningsText(symbol, null, surface);
  }
}
