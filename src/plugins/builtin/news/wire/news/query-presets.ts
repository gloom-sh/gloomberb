import type { NewsQuery } from "../../../../../news/types";

export const SECTOR_NEWS_SECTORS = [
  "information_technology",
  "energy",
  "financials",
  "health_care",
  "industrials",
  "consumer_discretionary",
  "consumer_staples",
  "communication_services",
  "materials",
  "utilities",
] as const;

export type SectorNewsSelection = "all" | typeof SECTOR_NEWS_SECTORS[number];

export const NEWS_QUERY_PRESETS = {
  top: { feed: "top", limit: 50 } satisfies NewsQuery,
  feed: { feed: "latest", limit: 200 } satisfies NewsQuery,
  breaking: { feed: "breaking", breaking: true, limit: 50 } satisfies NewsQuery,
  sectorAll: { feed: "sector", limit: 100 } satisfies NewsQuery,
  sector(sector: string): NewsQuery {
    return { feed: "sector", sectors: [sector], limit: 100 };
  },
  ticker(ticker: string, exchange?: string): NewsQuery {
    return {
      feed: "ticker",
      ticker,
      exchange,
      tickerTier: "primary",
      limit: 50,
    };
  },
} as const;

/** Short enough that the whole sector strip fits a normal pane width. */
const SECTOR_LABELS: Record<string, string> = {
  information_technology: "Tech",
  energy: "Energy",
  financials: "Financials",
  health_care: "Health",
  industrials: "Industry",
  consumer_discretionary: "Cons disc",
  consumer_staples: "Cons stap",
  communication_services: "Comms",
  materials: "Materials",
  utilities: "Utilities",
};

export function sectorNewsLabel(value: SectorNewsSelection): string {
  if (value === "all") return "All";
  return SECTOR_LABELS[value] ?? value.replace(/_/g, " ");
}
