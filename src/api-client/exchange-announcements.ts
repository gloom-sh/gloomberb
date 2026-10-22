/** One company announcement as its exchange released it (ASX). */
interface ExchangeAnnouncement {
  /** Release time, ISO 8601 UTC. */
  date: string;
  headline: string;
  /** The exchange's announcement types ("Quarterly Activities Report"). */
  types: string[];
  priceSensitive: boolean;
  /** "354KB", as the exchange states it; null when it does not. */
  fileSize: string | null;
  documentKey: string;
  /** The document on the exchange's site. */
  url: string;
}

/** A listed company's recent exchange announcements, from Gloom Cloud's `/cloud/announcements` (ASX only). */
export interface ExchangeAnnouncementsPayload {
  exchange: string;
  symbol: string;
  /** The company as the exchange names it; null when it does not say. */
  name: string | null;
  /** The company's announcements page on the exchange's site. */
  page: string;
  announcements: ExchangeAnnouncement[];
  /** How many announcements the exchange holds for the company; null when it does not say. */
  total: number | null;
  /** When Gloom Cloud read the list from the exchange. */
  retrievedAt: string;
  /** An earlier read, served because the exchange could not be reached. */
  stale?: boolean;
}

/** `/cloud/announcements?symbol=NST&exchange=ASX&limit=15`. */
export function cloudExchangeAnnouncementsPath(params: { symbol: string; exchange: string; limit?: number }): string {
  const search = new URLSearchParams({ symbol: params.symbol, exchange: params.exchange });
  if (params.limit != null) search.set("limit", String(params.limit));
  return `/cloud/announcements?${search}`;
}
