/**
 * Every ticker the app seeds: `DEFAULT_WATCHLIST_TICKERS` in
 * src/state/app/bootstrap.ts and `FIRST_RUN_WATCHLIST` in
 * src/components/onboarding/first-run-workspace.ts. A test keeps them equal.
 */
export const STARTER_SYMBOLS: ReadonlySet<string> = new Set([
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "BRK.B", "JPM", "V", "BTC-USD", "ETH-USD", "SPY", "QQQ",
]);
