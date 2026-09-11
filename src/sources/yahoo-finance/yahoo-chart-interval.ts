/** Keep in sync with the backend Yahoo service's yahoo-chart-interval.ts. */
const EARLIEST_HISTORY_SECOND = Date.parse("1900-01-01T00:00:00Z") / 1000;

/** Yahoo's range=max overrides interval (for example monthly SHIB becomes
 * weekly and monthly MSFT becomes quarterly). Explicit bounds retain the
 * requested interval. The early bound preserves available pre-1970 history;
 * it is a request boundary, not an assertion about an instrument's inception. */
export function yahooHistoryRangeParams(range: string, now = Date.now()): Record<string, string> {
  return range === "max"
    ? { period1: String(EARLIEST_HISTORY_SECOND), period2: String(Math.floor(now / 1000)) }
    : { range };
}

export function matchesYahooChartInterval(requested: string, served: unknown): boolean {
  if (typeof served !== "string" || !served.trim()) return false;
  const canonical = (value: string) => value === "1h" ? "60m" : value;
  return canonical(requested) === canonical(served);
}
