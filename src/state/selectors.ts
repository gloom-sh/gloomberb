import type { AppState } from "./app/context";

function getCollectionMembershipKey(state: AppState, collectionId: string | null): "portfolios" | "watchlists" | null {
  if (!collectionId) return null;
  if (state.config.portfolios.some((portfolio) => portfolio.id === collectionId)) return "portfolios";
  if (state.config.watchlists.some((watchlist) => watchlist.id === collectionId)) return "watchlists";
  return null;
}

export function getCollectionTickerCount(state: AppState, collectionId: string | null): number {
  const membershipKey = getCollectionMembershipKey(state, collectionId);
  if (!collectionId || !membershipKey) return 0;
  let count = 0;
  for (const ticker of state.tickers.values()) {
    if (ticker.metadata[membershipKey].includes(collectionId)) count += 1;
  }
  return count;
}

export function getCollectionName(state: AppState, collectionId: string | null): string {
  if (!collectionId) return "";
  const portfolio = state.config.portfolios.find((entry) => entry.id === collectionId);
  if (portfolio) return portfolio.name;
  const watchlist = state.config.watchlists.find((entry) => entry.id === collectionId);
  if (watchlist) return watchlist.name;
  return collectionId;
}
