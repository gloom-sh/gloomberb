import { describe, expect, test } from "bun:test";
import {
  INLINE_TICKER_ERROR_RETRY_MS,
  INLINE_TICKER_UNKNOWN_RETRY_MS,
  createInlineTickerFailureCache,
} from "./inline-ticker-failures";

describe("inline ticker failure cache", () => {
  test("a transient error expires so the symbol is tried again", () => {
    const cache = createInlineTickerFailureCache();
    const now = 1_000_000;

    cache.record("RSG", "error", now);

    expect(cache.read("RSG", now)).toBe("error");
    expect(cache.read("RSG", now + INLINE_TICKER_ERROR_RETRY_MS - 1)).toBe("error");
    expect(cache.read("RSG", now + INLINE_TICKER_ERROR_RETRY_MS)).toBeNull();
  });

  test("an unknown symbol is held far longer than a failed lookup", () => {
    const cache = createInlineTickerFailureCache();
    const now = 1_000_000;

    cache.record("NOPE", "unknown", now);

    expect(cache.read("NOPE", now + INLINE_TICKER_ERROR_RETRY_MS)).toBe("unknown");
    expect(cache.read("NOPE", now + INLINE_TICKER_UNKNOWN_RETRY_MS)).toBeNull();
  });

  test("an ambiguous symbol never expires, because retrying cannot settle it", () => {
    const cache = createInlineTickerFailureCache();
    const now = 1_000_000;

    cache.record("QSR", "ambiguous", now);

    expect(cache.read("QSR", now + INLINE_TICKER_UNKNOWN_RETRY_MS * 100)).toBe("ambiguous");
    expect(cache.nextRetryAt(["QSR"], now)).toBeNull();
  });

  test("the next retry is the soonest deadline among the symbols asked for", () => {
    const cache = createInlineTickerFailureCache();
    const now = 1_000_000;

    cache.record("AAA", "unknown", now);
    cache.record("BBB", "error", now);
    cache.record("CCC", "ambiguous", now);

    expect(cache.nextRetryAt(["AAA", "BBB", "CCC"], now)).toBe(now + INLINE_TICKER_ERROR_RETRY_MS);
    expect(cache.nextRetryAt(["AAA", "CCC"], now)).toBe(now + INLINE_TICKER_UNKNOWN_RETRY_MS);
    expect(cache.nextRetryAt(["DDD"], now)).toBeNull();
  });

  test("a resolved symbol drops its failure", () => {
    const cache = createInlineTickerFailureCache();

    cache.record("LIN", "error");
    cache.clear("LIN");

    expect(cache.read("LIN")).toBeNull();
  });

  test("rebinding the provider forgets every verdict it produced", () => {
    const cache = createInlineTickerFailureCache();
    const provider = {};
    const now = 1_000_000;

    cache.scopeTo(provider);
    cache.record("AMCR", "ambiguous", now);
    cache.scopeTo(provider);

    expect(cache.read("AMCR", now)).toBe("ambiguous");

    cache.scopeTo({});

    expect(cache.read("AMCR", now)).toBeNull();
  });
});
