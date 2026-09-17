/**
 * Resolving an inline ticker is a network lookup, and a lookup fails in three
 * different ways that deserve three different answers:
 *
 * - `unknown`: the provider answered and knows no such symbol. Asking again in
 *   a minute repeats the same answer, so the verdict is held for a long while.
 * - `error`: the lookup itself failed (offline, rate limited, provider hiccup).
 *   That describes the moment, not the symbol, so it expires quickly.
 * - `ambiguous`: the symbol names more than one listing and only a person can
 *   say which one. No amount of retrying settles it, so it is held until the
 *   symbol resolves locally or the market data provider is replaced.
 *
 * Holding every failure for the lifetime of the process was the old behaviour,
 * and it let one flaky lookup hide a badge until the app restarted.
 */
export type InlineTickerFailureKind = "unknown" | "error" | "ambiguous";

export const INLINE_TICKER_UNKNOWN_RETRY_MS = 10 * 60_000;
export const INLINE_TICKER_ERROR_RETRY_MS = 30_000;

const RETRY_DELAYS_MS: Record<InlineTickerFailureKind, number> = {
  unknown: INLINE_TICKER_UNKNOWN_RETRY_MS,
  error: INLINE_TICKER_ERROR_RETRY_MS,
  ambiguous: Number.POSITIVE_INFINITY,
};

interface CachedFailure {
  kind: InlineTickerFailureKind;
  retryAt: number;
}

export interface InlineTickerFailureCache {
  /** The failure still standing for a symbol, or null once it may be retried. */
  read(symbol: string, now?: number): InlineTickerFailureKind | null;
  record(symbol: string, kind: InlineTickerFailureKind, now?: number): void;
  clear(symbol: string): void;
  /** When the soonest of these symbols becomes retryable, or null if none will. */
  nextRetryAt(symbols: readonly string[], now?: number): number | null;
  /**
   * Failures describe one market data provider. Rebinding the registry means a
   * different provider, a reconnect, or a restored network, so its verdicts no
   * longer apply and every symbol gets a fresh chance.
   */
  scopeTo(scope: unknown): void;
  reset(): void;
}

export function createInlineTickerFailureCache(): InlineTickerFailureCache {
  const failures = new Map<string, CachedFailure>();
  let scope: unknown;
  let scoped = false;

  return {
    read(symbol, now = Date.now()) {
      const failure = failures.get(symbol);
      if (!failure) return null;
      if (now < failure.retryAt) return failure.kind;
      failures.delete(symbol);
      return null;
    },
    record(symbol, kind, now = Date.now()) {
      failures.set(symbol, { kind, retryAt: now + RETRY_DELAYS_MS[kind] });
    },
    clear(symbol) {
      failures.delete(symbol);
    },
    nextRetryAt(symbols, now = Date.now()) {
      let soonest: number | null = null;
      for (const symbol of symbols) {
        const failure = failures.get(symbol);
        if (!failure || !Number.isFinite(failure.retryAt)) continue;
        const retryAt = Math.max(failure.retryAt, now);
        if (soonest === null || retryAt < soonest) soonest = retryAt;
      }
      return soonest;
    },
    scopeTo(nextScope) {
      if (scoped && scope === nextScope) return;
      scoped = true;
      scope = nextScope;
      failures.clear();
    },
    reset() {
      failures.clear();
      scope = undefined;
      scoped = false;
    },
  };
}

/** Symbols the provider could not turn into a ticker. */
export const inlineTickerResolutionFailures = createInlineTickerFailureCache();

/** Tickers the provider could not quote. */
export const inlineTickerQuoteFailures = createInlineTickerFailureCache();

export function resetInlineTickerFailures(): void {
  inlineTickerResolutionFailures.reset();
  inlineTickerQuoteFailures.reset();
}
