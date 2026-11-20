import type { CryptoMarketAsset } from "../../../api-client/crypto-markets";
import type { TickerRecord } from "../../../types/ticker";
import type { TickerFinancials } from "../../../types/financials";
import { isRoundTheClockCoin, MAJOR_COIN_NAMES, TOP_COIN_NAMES } from "../../../utils/crypto-pair";
import { parsePublicTickerKey } from "../../../utils/exchanges";

/**
 * The coin a ticker page stands for: the code its listing's pair names (BTC for
 * BTC-USD). Null for a bare ticker whose code names a listed company or fund
 * first (SOL is a stale Emeren Group), so that page keeps its equity tabs, and
 * for a pair Gloom does not read as a coin's (BTC-USDT).
 */
export function coinIdentityOf(context: { ticker: TickerRecord | null; financials: TickerFinancials | null | undefined }): { code: string } | null {
  const symbol = context.ticker?.metadata.ticker;
  const exchange = context.ticker?.metadata.exchange || context.financials?.quote?.exchangeName;
  if (!symbol || !isRoundTheClockCoin(symbol, exchange)) return null;
  const listing = parsePublicTickerKey(symbol).symbol.trim().toUpperCase();
  const pair = /^([A-Z0-9]{1,15})[-/][A-Z]{3,4}$/.exec(listing);
  const code = pair?.[1] ?? listing;
  if (!pair && !MAJOR_COIN_NAMES.has(code)) return null;
  return { code };
}

/** The market-cap row a coin's page reads, by its code first, then by the name stories give it. */
export function findCoinAsset(assets: readonly CryptoMarketAsset[], code: string): CryptoMarketAsset | null {
  const byCode = assets.find((asset) => asset.code.toUpperCase() === code);
  if (byCode) return byCode;
  const name = MAJOR_COIN_NAMES.get(code) ?? TOP_COIN_NAMES.get(code);
  if (!name) return null;
  return assets.find((asset) => asset.name.trim().toLowerCase() === name) ?? null;
}
