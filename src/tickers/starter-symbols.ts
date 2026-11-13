/**
 * Every ticker the app seeds: `DEFAULT_WATCHLIST_TICKERS` in
 * src/state/app/bootstrap.ts and `FIRST_RUN_WATCHLIST` in
 * src/components/onboarding/first-run-workspace.ts. A test keeps them equal.
 */
export const STARTER_SYMBOLS: ReadonlySet<string> = new Set([
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "BRK.B", "JPM", "V", "BTC-USD", "ETH-USD", "SPY", "QQQ",
]);

/**
 * The seeded lists hold 7 (the first run) or 12 (startup) starter tickers,
 * so a list with fewer was trimmed or built by hand: the server, the Monday
 * brief and the company picker take it as the user's own.
 */
export const SEEDED_LIST_MIN_STARTERS = 7;
