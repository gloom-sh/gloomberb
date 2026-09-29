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

/**
 * NI codes, Bloomberg style: topics the service tags from a story's text and
 * source (`NI MNA`), and the sectors NI always had (`NI TECH`). ENERGY is a
 * topic, so it takes energy news from every sector.
 */
export interface NewsIndustryCode {
  code: string;
  label: string;
  topic?: string;
  sector?: typeof SECTOR_NEWS_SECTORS[number];
}

export const NEWS_INDUSTRY_CODES: readonly NewsIndustryCode[] = [
  { code: "ALL", label: "All" },
  { code: "MNA", label: "M&A", topic: "mna" },
  { code: "CB", label: "Central banks", topic: "cb" },
  { code: "ENERGY", label: "Energy", topic: "energy" },
  { code: "REG", label: "Regulation", topic: "reg" },
  { code: "CRYPTO", label: "Crypto", topic: "crypto" },
  { code: "EARN", label: "Earnings", topic: "earn" },
  { code: "IPO", label: "IPOs", topic: "ipo" },
  { code: "TECH", label: "Tech", sector: "information_technology" },
  { code: "FIN", label: "Financials", sector: "financials" },
  { code: "HEALTH", label: "Health care", sector: "health_care" },
  { code: "INDU", label: "Industrials", sector: "industrials" },
  { code: "CONSD", label: "Consumer discretionary", sector: "consumer_discretionary" },
  { code: "CONSS", label: "Consumer staples", sector: "consumer_staples" },
  { code: "COMMS", label: "Communication services", sector: "communication_services" },
  { code: "MATS", label: "Materials", sector: "materials" },
  { code: "UTIL", label: "Utilities", sector: "utilities" },
];

const INDUSTRY_CODE_ALIASES: Record<string, string> = {
  "m&a": "MNA",
  ma: "MNA",
  mergers: "MNA",
  fed: "CB",
  earnings: "EARN",
  ipos: "IPO",
  regulation: "REG",
};

function industryKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * A code from what was typed or saved: "mna", "M&A", and the sector ids and
 * tab labels NI used before codes ("information_technology", "Cons disc").
 */
export function parseNewsIndustryCode(value: string | null | undefined): NewsIndustryCode | null {
  if (!value?.trim()) return null;
  const key = industryKey(value);
  const code = INDUSTRY_CODE_ALIASES[key]?.toLowerCase() ?? key;
  return NEWS_INDUSTRY_CODES.find((entry) => (
    entry.code.toLowerCase() === code
    || entry.sector === code
    || industryKey(entry.label) === key
    || (entry.sector && industryKey(sectorNewsLabel(entry.sector)) === key)
  )) ?? null;
}

export const NEWS_QUERY_PRESETS = {
  top: { feed: "top", limit: 20 } satisfies NewsQuery,
  feed: { feed: "latest", limit: 200 } satisfies NewsQuery,
  breaking: { feed: "breaking", breaking: true, limit: 50 } satisfies NewsQuery,
  sectorAll: { feed: "sector", limit: 100 } satisfies NewsQuery,
  sector(sector: string): NewsQuery {
    return { feed: "sector", sectors: [sector], limit: 100 };
  },
  topic(topic: string): NewsQuery {
    return { feed: "topic", topics: [topic], limit: 100 };
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
