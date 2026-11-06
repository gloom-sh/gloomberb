// An alert's prices as every surface writes them (ALRT, `fn ALRT`, `alerts
// list`, `alerts add` and the toast): at the instrument's precision, as
// `quote` prints it, and a London line in the pence it trades in.
import { currencyMinorDigits, formatMarketPrice, type MarketFormatOptions } from "../../../market-data/market/format";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { isCurrencyPairListing } from "../../../utils/fx-market-hours";
import { listingSuffixCandidate } from "../../../sources/listing-symbols";
import type { AlertRule } from "./types";

/** The fields of an alert its prices are written from. */
export type AlertPriceSubject = Pick<AlertRule, "symbol" | "exchange" | "lastQuoteExchange" | "lastQuoteCurrency" | "lastQuotePence">;

/** Whether an alert is on a currency pair (GBPUSD=X, EURUSD:CCY), whose rates print to the pair's precision. */
export function isCurrencyPairAlert(alert: Pick<AlertRule, "symbol" | "exchange" | "lastQuoteExchange">): boolean {
  return isCurrencyPairListing(alert.symbol, alert.exchange || alert.lastQuoteExchange);
}

/** Whether an alert's listing trades in pence (a London line priced in pounds, 117.35p), which its levels are written in. */
export function isPenceAlert(alert: Pick<AlertRule, "lastQuotePence">): boolean {
  return alert.lastQuotePence === true;
}

/** A price's decimals, padded to its currency's minor unit (USD 2, JPY none) as `quote` pads them; a pair at its own precision. */
function priceOptions(alert: AlertPriceSubject, maxWidth?: number): MarketFormatOptions {
  const currency = alert.lastQuoteCurrency;
  if (isCurrencyPairAlert(alert)) return { assetCategory: "CURRENCY", ...currency ? { currency } : {}, ...maxWidth ? { maxWidth } : {} };
  return {
    ...currency ? { currency } : {},
    minimumFractionDigits: Math.min(2, currencyMinorDigits(currency)),
    ...maxWidth ? { maxWidth } : {},
  };
}

/**
 * An alert price as its instrument prints: `1.33750` on GBP/USD, `2,800` on
 * Toyota in yen, `70.00p` on a London line in pence, `250.00` in dollars.
 * Numbers only, with the pence sign where the unit is pence; `maxWidth` fits a
 * table cell.
 */
export function alertPriceText(alert: AlertPriceSubject, value: number, maxWidth?: number): string {
  if (!Number.isFinite(value)) return "-";
  if (isPenceAlert(alert)) {
    const pence = formatMarketPrice(value * 100, { minimumFractionDigits: 2, ...maxWidth ? { maxWidth: Math.max(1, maxWidth - 1) } : {} });
    return `${pence}p`;
  }
  return formatMarketPrice(value, priceOptions(alert, maxWidth));
}

/**
 * The listing an alert is kept under, one key however it was typed: 7203.T,
 * `7203 JP`, 7203:JPX and a rule saved by an older version as symbol
 * `7203:JPX` on JPX are all `7203:JPX`; a bare symbol is its quote's venue
 * once checked (AAPL:NASDAQ), else the symbol alone.
 */
export function alertListingKey(alert: Pick<AlertRule, "symbol" | "exchange" | "lastQuoteExchange">): string {
  const typed = parsePublicTickerKey(alert.symbol);
  const venue = canonicalExchange(typed.exchange || alert.exchange || alert.lastQuoteExchange || "");
  const suffix = listingSuffixCandidate(typed.symbol);
  const symbol = suffix && (!venue || canonicalExchange(suffix.exchange) === venue) ? suffix.symbol : typed.symbol;
  const exchange = venue || (suffix ? canonicalExchange(suffix.exchange) : "");
  return exchange ? `${symbol}:${exchange}` : symbol;
}
