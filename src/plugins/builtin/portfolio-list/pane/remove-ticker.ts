import { t, tf } from "../../../../i18n";
import { formatMarketCost, formatMarketQuantity } from "../../../../market-data/market/format";
import type { AppConfig } from "../../../../types/config";
import type { TickerRecord } from "../../../../types/ticker";
import { parseCollectionRef } from "../../cloud/team/collections";
import { isManualPortfolio, removeTickerFromPortfolio, removeTickerFromWatchlist } from "../mutations";

export interface RemovableCollection {
  kind: "portfolio" | "watchlist";
  id: string;
  name: string;
}

function isTeamCollection(entry: { id: string; teamId?: string }): boolean {
  return !!entry.teamId || parseCollectionRef(entry.id).scope === "team";
}

/**
 * The open list when `d` may take a ticker out of it: a manual portfolio or a
 * personal watchlist. A broker sync would put the symbol back, and a team list
 * is shared with everyone on the team, so neither offers it.
 */
export function removableCollection(config: AppConfig, collectionId: string | null): RemovableCollection | null {
  if (!collectionId) return null;
  const portfolio = config.portfolios.find((entry) => entry.id === collectionId);
  if (portfolio) {
    return isManualPortfolio(portfolio) && !isTeamCollection(portfolio)
      ? { kind: "portfolio", id: portfolio.id, name: portfolio.name }
      : null;
  }
  const watchlist = config.watchlists.find((entry) => entry.id === collectionId);
  return watchlist && !isTeamCollection(watchlist)
    ? { kind: "watchlist", id: watchlist.id, name: watchlist.name }
    : null;
}

export function removeTickerFromCollection(
  ticker: TickerRecord,
  collection: RemovableCollection,
): { changed: boolean; ticker: TickerRecord } {
  return collection.kind === "portfolio"
    ? removeTickerFromPortfolio(ticker, collection.id)
    : removeTickerFromWatchlist(ticker, collection.id);
}

/** The confirm's lines: what leaves with the ticker, then what stays. */
export function tickerRemovalSummary(ticker: TickerRecord, collection: RemovableCollection): string[] {
  if (collection.kind === "watchlist") return [t("Positions, notes and other lists stay.")];
  const positions = ticker.metadata.positions.filter((position) => position.portfolio === collection.id);
  const stays = t("Notes and other lists stay.");
  if (positions.length === 0) return [stays];
  const assetCategory = ticker.metadata.assetCategory;
  const quantity = formatMarketQuantity(
    positions.reduce((sum, position) => sum + position.shares, 0),
    { assetCategory },
  );
  const [position] = positions;
  if (positions.length > 1 || position?.avgCost == null) {
    return [
      positions.length > 1
        ? tf("Its {count} positions here, {quantity} in all, are deleted.", { count: positions.length, quantity })
        : tf("Its position here, {quantity}, is deleted.", { quantity }),
      stays,
    ];
  }
  const cost = formatMarketCost(position.avgCost, { assetCategory, priceBasis: position.priceBasis, minimumFractionDigits: 2 });
  const currency = position.currency ?? ticker.metadata.currency ?? "";
  return [
    tf("Its position here, {quantity} at {cost} avg cost, is deleted.", {
      quantity,
      cost: currency ? `${cost} ${currency}` : cost,
    }),
    stays,
  ];
}

/**
 * Where the cursor goes once `removed` leaves the list: the row that took its
 * place, or the one above when it was last.
 */
export function cursorAfterRemoval(symbols: readonly string[], removed: string): string | null {
  const index = symbols.indexOf(removed);
  if (index < 0) return symbols[0] ?? null;
  return symbols[index + 1] ?? symbols[index - 1] ?? null;
}
