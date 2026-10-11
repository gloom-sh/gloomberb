/** Who publishes the prices; their licence asks for this attribution. */
interface EuropeEnergySource {
  name: string;
  licence: string;
  url: string;
}

/** One market's latest day-ahead price and its context, all as of `date`. */
export interface PowerPriceRow {
  /** ISO 3166 alpha-2: DE, FR, GB. */
  code: string;
  name: string;
  /** Latest delivery day with a price. */
  date: string | null;
  /** EUR/MWh, the day's load-weighted average of the day-ahead auction. */
  price: number | null;
  previousDate: string | null;
  change: number | null;
  average7: number | null;
  average30: number | null;
  yearAgoDate: string | null;
  yearAgo: number | null;
  low52w: number | null;
  high52w: number | null;
  /** Weekly means over the year to `date`, oldest first. */
  trail: Array<{ date: string; value: number }>;
}

export interface EuropePowerBoard {
  generatedAt: string;
  status: "available" | "unavailable";
  market: "day-ahead";
  unit: "EUR/MWh";
  source: EuropeEnergySource;
  /** When the published file was last read, and when its publisher last changed it. */
  checkedAt: string | null;
  publishedAt: string | null;
  gaps: string[];
  rows: PowerPriceRow[];
}

export interface EuropePowerHistory {
  code: string;
  name: string;
  market: "day-ahead";
  unit: "EUR/MWh";
  source: EuropeEnergySource;
  /** Oldest first. */
  points: Array<{ date: string; value: number }>;
}
