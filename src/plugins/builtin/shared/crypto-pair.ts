/**
 * The coin a USD crypto pair names: BTC-USD gives BTC. CME lists bitcoin and
 * ether futures, but BTC and ETH are also US equity tickers (Grayscale's mini
 * trusts), so a futures function that falls back to the ticker under the
 * cursor reads a bare symbol as the equity and only a pair as the coin.
 */
export function cryptoPairCoin(ticker: string): string | null {
  return /^([A-Z0-9]{2,10})-USD$/.exec(ticker.trim().toUpperCase())?.[1] ?? null;
}

/** `BTC=F`: the spelling of a futures contract, which no equity shares. */
export function isFuturesSymbol(ticker: string): boolean {
  return ticker.trim().toUpperCase().endsWith("=F");
}
