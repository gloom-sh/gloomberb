import type { KeptListing } from "../../tickers/search/listing-index";

/**
 * `movers hk`: Hong Kong's gainers or losers, ranked by the regular session's
 * move. The upstream movers lists rank US listings only, so the universe is
 * the large HKEX stocks the app ships for search (the Hang Seng's members and
 * the other large caps of `bun run listings:snapshot`), quoted through the
 * same batched quote path as `quote`, and the report says so.
 */
export const HONG_KONG_MOVERS_MARKET = "hk";
export type HongKongMoversList = "gainers" | "losers";

/** The universe: each HKEX common stock among the shipped major listings, once, as `quote` takes it. */
export function hongKongMoverUniverse(listings: readonly KeptListing[]): Array<{ code: string; name: string }> {
  const seen = new Set<string>();
  return listings.flatMap(([symbol, name, exchange, type]) => {
    if (exchange !== "HKEX" || type !== "Common Stock" || seen.has(symbol)) return [];
    seen.add(symbol);
    return [{ code: symbol, name }];
  });
}

/** The smallest company the list ranks: a large cap, as the Hang Seng's members are. */
export const HONG_KONG_MIN_MARKET_CAP = 10_000_000_000;

/** What the list ranks, said under its title. */
export function hongKongUniverseNote(count: number): string {
  return `Ranks ${count} HKEX stocks of HK$10B or more (the Hang Seng's members and the other large caps the app lists) by the regular session's move.`;
}

/**
 * Whether a quoted stock is in the ranked universe: a Hong Kong dollar
 * market cap of HK$10B or more, and a price from the session in progress or
 * the last one (a stale or suspended quote has no move to rank).
 */
export function inHongKongUniverse(quote: { currency?: string; marketCap?: number | null } | null | undefined, stale: boolean): boolean {
  return !!quote && !stale && quote.currency === "HKD" && (quote.marketCap ?? 0) >= HONG_KONG_MIN_MARKET_CAP;
}

/**
 * The rows moving the list's way, largest move first: a gainer up, a loser
 * down, and a row with no move (no quote, or none this session) left out.
 */
export function rankHongKongMovers<T extends { changePercent: number | null }>(rows: readonly T[], list: HongKongMoversList, limit: number): T[] {
  const sign = list === "gainers" ? 1 : -1;
  return rows.filter((row) => row.changePercent != null && row.changePercent * sign > 0)
    .toSorted((a, b) => sign * (b.changePercent! - a.changePercent!))
    .slice(0, limit);
}
