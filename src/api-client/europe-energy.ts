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

/** One EU ETS primary-market auction. Prices in EUR/tCO2, volumes in tCO2. */
interface CarbonAuction {
  date: string;
  auction: string;
  contract: string;
  /** successful, cancelled. */
  status: string;
  /** EU (common platform), DE, PL, XI (Northern Ireland). */
  zone: string | null;
  /** Null when the auction did not clear. */
  price: number | null;
  minBid: number | null;
  maxBid: number | null;
  meanBid: number | null;
  medianBid: number | null;
  volume: number;
  coverRatio: number | null;
  bidders: number | null;
  successfulBidders: number | null;
  /** An aviation allowance (EUAA) auction, which is not the EUA price. */
  aviation: boolean;
}

/** The EUA price as of its latest auction day: the day's cleared auctions, volume-weighted. */
interface CarbonPriceRow extends Omit<PowerPriceRow, "code"> {
  code: "EUA";
  /** tCO2 auctioned that day, and in how many auctions. */
  volume: number | null;
  auctions: number | null;
}

export interface CarbonBoard {
  generatedAt: string;
  status: "available" | "unavailable";
  /** The primary auction clearing price, not a futures settlement. */
  market: "primary auction";
  unit: "EUR/tCO2";
  source: { name: string; url: string };
  checkedAt: string | null;
  publishedAt: string | null;
  gaps: string[];
  row: CarbonPriceRow;
  /** Newest first. */
  auctions: CarbonAuction[];
}

export interface CarbonHistory {
  code: "EUA";
  name: string;
  market: "primary auction";
  unit: "EUR/tCO2";
  source: { name: string; url: string };
  /** Each auction day's price, oldest first. */
  points: Array<{ date: string; value: number }>;
}
