import type { DepositaryPair, Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../../../../utils/exchanges";
import { listingSuffixCandidate, listingSuffixVenue } from "../../../../sources/listing-symbols";
import { formatMarketPriceWithCurrency, liveQuoteFormatOptions, type MarketFormatOptions } from "../../../../market-data/market/format";
import { heldCurrencyUnit } from "../../../../utils/currency-units";
import { adrRatioText } from "../../../../utils/depositary-receipt";
import {
  compareDepositaryPair, dollarPairLabel, formatPairRate, isReceiptSide, listingDepositaryPair, pairPriceInput, pairTimeText,
  premiumText, ratioCount, spotRateKind, type DepositaryPairComparison, type PairPriceInput, type PairSpotInput,
} from "../../../../market-data/depositary-pair";

/** The DES tab a listing with a known receipt pair gets, and the function that opens DES on it. */
export const ADR_PAIR_TAB_ID = "adr-vs-home";
export const ADR_PAIR_TEMPLATE_ID = "adr-pair-pane";

/** The two listings a pair compares, from one side's records: the listing itself and the other line. */
export interface AdrPairLegs {
  pair: DepositaryPair;
  /** The listing is the receipt (else one of the home lines). */
  receiptSide: boolean;
  receiptKey: string;
  homeKey: string;
  /** The line to quote besides the listing's own. */
  otherKey: string;
}

/** Whether a home line of the pair is the listing (GGAL.BA for GGAL on BYMA). */
function sameListing(line: string, symbol: string, exchange: string | undefined): boolean {
  const own = parsePublicTickerKey(symbol);
  const ownSuffix = listingSuffixVenue(own.symbol, exchange);
  const ownSymbol = ownSuffix?.symbol ?? own.symbol;
  const ownVenue = canonicalExchange(ownSuffix?.exchange ?? own.exchange ?? exchange);
  if (line.toUpperCase() === symbol.toUpperCase()) return true;
  // A served line's suffix names its venue, a one-letter one too (GSK.L is GSK on LSE).
  const venue = listingSuffixCandidate(line);
  return !!venue && venue.symbol === ownSymbol && canonicalExchange(venue.exchange) === ownVenue;
}

export function adrPairLegs(
  financials: Pick<TickerFinancials, "quote" | "fundamentals"> | null | undefined,
  ticker: Pick<TickerRecord, "metadata"> | null | undefined,
  symbol: string | null | undefined,
): AdrPairLegs | null {
  const pair = listingDepositaryPair(financials);
  if (!pair) return null;
  const receiptSide = isReceiptSide(financials);
  const ownSymbol = ticker?.metadata.ticker ?? symbol ?? "";
  const ownExchange = ticker?.metadata.exchange || financials?.quote?.listingExchangeName || undefined;
  if (receiptSide) return { pair, receiptSide, receiptKey: pair.receipt, homeKey: pair.ordinary[0]!, otherKey: pair.ordinary[0]! };
  const home = pair.ordinary.find((line) => sameListing(line, ownSymbol, ownExchange))
    ?? (ownExchange && !parsePublicTickerKey(ownSymbol).exchange ? publicTickerKey(ownSymbol, ownExchange) : ownSymbol);
  return { pair, receiptSide, receiptKey: pair.receipt, homeKey: home, otherKey: pair.receipt };
}

/** The comparison from the two quotes and the home currency's USD value (as exchange rates are served). */
export function adrPairComparison(
  legs: AdrPairLegs,
  quotes: { receipt: Quote | null | undefined; home: Quote | null | undefined },
  spot: PairSpotInput | null,
  now = Date.now(),
): DepositaryPairComparison | null {
  return compareDepositaryPair(legs.pair.ratio, pairPriceInput(legs.receiptKey, quotes.receipt), pairPriceInput(legs.homeKey, quotes.home), spot, now);
}

export interface AdrPairFigure {
  id: string;
  label: string;
  value: string;
  detail?: string;
}

/** The figures the tab heads with: the implied rate, spot, the premium and the ratio. */
export function adrPairFigures(comparison: DepositaryPairComparison): AdrPairFigure[] {
  const currency = comparison.home.currency;
  const pairLabel = dollarPairLabel(currency);
  const kind = spotRateKind(currency);
  return [
    {
      id: "implied", label: `Implied ${pairLabel}`, value: formatPairRate(comparison.impliedFx),
      // Through a receipt the peso rate is the CCL rate traders quote.
      detail: currency === "ARS" ? "CCL" : `home × ${ratioCount(comparison.ratio)} / ADR`,
    },
    {
      id: "spot", label: `Spot ${pairLabel}`, value: comparison.spot ? formatPairRate(comparison.spot.rate) : "—",
      ...(kind ? { detail: kind } : {}),
    },
    {
      id: "premium", label: "ADR vs home",
      value: comparison.premiumPercent == null ? "—" : premiumText(comparison.premiumPercent),
      ...(comparison.premiumPercent == null ? {} : { detail: "at spot" }),
    },
    { id: "ratio", label: "Ratio", value: adrRatioText(comparison.ratio) ?? `1:${ratioCount(comparison.ratio)}` },
  ];
}

export interface AdrPairInputRow {
  id: "home" | "receipt" | "spot";
  listing: string;
  role: string;
  price: string;
  asOf: string;
  session: string;
  /** The listing a row opens, none for the spot rate. */
  opens: string | null;
}

function sessionText(input: PairPriceInput): string {
  return input.open ? "Open" : "Closed";
}

/**
 * A leg's price written as the quote monitor writes the listing's: its
 * instrument's own decimals (cents on a dollar price, $419.50 and never
 * $419.5). The comparison reads a minor unit (GBp) in its currency, so the
 * session prices the decimals come from are read in it too.
 */
function legPriceOptions(input: PairPriceInput, quote: Quote | null | undefined): MarketFormatOptions {
  const divisor = quote?.currency ? heldCurrencyUnit(quote.currency).divisor : 1;
  const inCurrency = (value: number | undefined) => value == null ? value : value / divisor;
  return liveQuoteFormatOptions(
    quote ? { ...quote, previousClose: inCurrency(quote.previousClose), regularClose: inCurrency(quote.regularClose), open: inCurrency(quote.open) } : null,
    input.currency,
  );
}

/** The inputs the figures come from, each with when it was set. */
export function adrPairInputRows(
  comparison: DepositaryPairComparison,
  quotes: { receipt: Quote | null | undefined; home: Quote | null | undefined },
  now = Date.now(),
): AdrPairInputRow[] {
  const { home, receipt, spot, ratio } = comparison;
  const time = (value: number | null) => value == null ? "—" : pairTimeText(value, now).replace(/ UTC$/, "");
  const kind = spotRateKind(home.currency);
  return [
    {
      id: "home", listing: home.symbol, role: `Home, ${ratioCount(ratio)} per ADR`,
      price: formatMarketPriceWithCurrency(home.price, home.currency, { ...legPriceOptions(home, quotes.home), currencyCode: true }),
      asOf: time(home.observedAt), session: sessionText(home), opens: home.symbol,
    },
    {
      id: "receipt", listing: receipt.symbol, role: "ADR",
      price: formatMarketPriceWithCurrency(receipt.price, receipt.currency, legPriceOptions(receipt, quotes.receipt)), asOf: time(receipt.observedAt),
      session: sessionText(receipt), opens: receipt.symbol,
    },
    ...spot ? [{
      id: "spot" as const, listing: dollarPairLabel(home.currency), role: kind ? `Spot, ${kind}` : "Spot",
      price: formatPairRate(spot.rate), asOf: time(spot.observedAt), session: "", opens: null,
    }] : [],
  ];
}
