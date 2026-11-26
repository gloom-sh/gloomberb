import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import { isFuturesInstrument, loadFuturesContractTermsCached } from "../../../market-data/futures-contract";
import { resolveAssetDisplayKind } from "../../../market-data/market/format";
import { getCompletedRegularSessionDisplay, getExtendedSessionDisplay } from "../../../market-data/market/status";
import { regularSessionValuationPrice, regularSessionValuationTime } from "../../../market-data/quotes/regular-session-valuation";
import { futuresContractSize } from "../../../portfolio/futures-positions";
import type { Quote } from "../../../types/financials";
import { isRoundTheClockCoin } from "../../../utils/crypto-pair";
import { formatCurrencyCode, formatNumber } from "../../../utils/format";
import { logFailure } from "../../../utils/log-failure";
import { formatUtcTime } from "../../../utils/utc-time";

/** What a Kelly position is counted in: shares of a stock or fund, units of a coin, contracts of a future. */
export type KellyCount = "shares" | "units" | "contracts";

export function kellyCount(symbol: string, exchange: string, instrumentType: string | null | undefined): KellyCount {
  if (isFuturesInstrument(symbol, instrumentType)) return "contracts";
  return isRoundTheClockCoin(symbol, exchange) ? "units" : "shares";
}

export function kellySizingPrice(quote: Quote | null | undefined, count: KellyCount, instrumentType = quote?.instrumentType) {
  if (!quote) return null;
  const equity = count === "shares" && resolveAssetDisplayKind({ assetCategory: instrumentType }) === "equity";
  const completed = equity && getCompletedRegularSessionDisplay(quote) != null;
  if (equity && !completed && (getExtendedSessionDisplay(quote) || quote.marketState === "PRE" || quote.marketState === "POST")) return null;
  const value = equity ? regularSessionValuationPrice(quote) : quote.price;
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const stamp = equity ? regularSessionValuationTime(quote)
    : Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0 ? { time: quote.lastUpdated, dateOnly: false } : null;
  const asOf = stamp?.dateOnly ? new Date(stamp.time).toISOString().slice(0, 10) : stamp?.time ?? null;
  const session = completed || (equity && quote.marketState === "CLOSED") ? "Regular close"
    : equity && quote.marketState === "REGULAR" ? "Regular session" : "Last quote";
  return { value, currency: quote.currency || null, asOf, session };
}

export function formatKellySizingPrice(price: NonNullable<ReturnType<typeof kellySizingPrice>>) {
  const amount = price.currency ? formatCurrencyCode(price.value, price.currency) : formatNumber(price.value, 4);
  return [amount, price.session, price.asOf == null ? null : formatUtcTime(price.asOf)].filter(Boolean).join(" · ");
}

/**
 * What one of the count is worth per unit of price: a future's contract
 * multiplier from the exchange's terms (ES's $50 a point, ZC's 5,000 bushels
 * on a price in cents), 1 for a share or a coin. Null for a future whose terms
 * cannot be read, so a position is never counted in price points.
 */
export async function kellyCountMultiplier(
  symbol: string,
  count: KellyCount,
  load: (symbol: string) => Promise<FuturesContractTermsPayload | null> = loadFuturesContractTermsCached,
): Promise<number | null> {
  if (count !== "contracts") return 1;
  const terms = await load(symbol).catch(logFailure("kelly-sizer.units", "Read futures contract terms failed", null));
  return futuresContractSize(terms?.spec)?.multiplier ?? null;
}
