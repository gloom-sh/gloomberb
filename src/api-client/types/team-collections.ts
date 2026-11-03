// Team collections

export type TeamCollectionKind = "watchlist" | "portfolio";

export interface TeamCollection {
  id: string;
  teamId: string;
  kind: TeamCollectionKind;
  name: string;
  currency: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface TeamCollectionItem {
  collectionId: string;
  symbol: string;
  exchange: string;
  quantity: number | null;
  note: string | null;
  /**
   * A portfolio holding's purchase date (YYYY-MM-DD), its currency, and the
   * rate its cost was bought at (one unit of `currency` in `costFxCurrency`).
   * Null when no one has sent one; missing from a server that keeps none.
   */
  dateAcquired?: string | null;
  currency?: string | null;
  costFxRate?: number | null;
  costFxCurrency?: string | null;
  addedBy: string;
  addedAt: string;
  updatedAt: string;
}

type TeamCollectionChange =
  | { change: "created"; collection: TeamCollection }
  | { change: "updated"; collection: TeamCollection }
  | { change: "deleted"; collectionId: string }
  | { change: "item-added" | "item-updated" | "item-removed"; collectionId: string; item: TeamCollectionItem };

export type TeamCollectionEvent = TeamCollectionChange & { teamId: string; actorId: string };
