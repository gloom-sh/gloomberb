import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import { isFuturesInstrument, loadFuturesContractTermsCached } from "../../../market-data/futures-contract";
import { futuresContractSize } from "../../../portfolio/futures-positions";
import { isRoundTheClockCoin } from "../../../utils/crypto-pair";
import { logFailure } from "../../../utils/log-failure";

/** What a Kelly position is counted in: shares of a stock or fund, units of a coin, contracts of a future. */
export type KellyCount = "shares" | "units" | "contracts";

export function kellyCount(symbol: string, exchange: string, instrumentType: string | null | undefined): KellyCount {
  if (isFuturesInstrument(symbol, instrumentType)) return "contracts";
  return isRoundTheClockCoin(symbol, exchange) ? "units" : "shares";
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
