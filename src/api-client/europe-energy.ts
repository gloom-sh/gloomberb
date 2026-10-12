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

/** Percent full, TWh in storage, GWh/day flows: as GIE AGSI+ publishes them. */
interface GasStorageUnits {
  full: "%";
  storage: "TWh";
  flow: "GWh/day";
}

/** The platform's own flag for a gas day. */
type GasReadingStatus = "estimated" | "confirmed";

/** Fullness on the same calendar day in the five years before the gas day's own; fewer where history is short. */
interface GasFiveYear {
  years: number[];
  min: number;
  max: number;
  average: number;
  /** Percentage points against the average. */
  vsAverage: number;
  /** 0 at the low, 100 at the high, beyond either outside the range; null under two years. */
  position: number | null;
}

/** One area's latest gas day with a reading: the EU aggregate or a member state. */
export interface GasStorageRow {
  /** EU, or ISO 3166 alpha-2. */
  code: string;
  name: string;
  /** The gas day, dated by its start. */
  gasDay: string | null;
  status: GasReadingStatus | null;
  /** Percent of working gas volume. */
  full: number | null;
  /** TWh. */
  gasInStorage: number | null;
  workingGasVolume: number | null;
  /** GWh/day. */
  injection: number | null;
  withdrawal: number | null;
  previousGasDay: string | null;
  /** Percentage points against the gas day before. */
  change: number | null;
  yearAgo: { gasDay: string; full: number; gasInStorage: number | null; change: number } | null;
  fiveYear: GasFiveYear | null;
  /** Fullness at the end of each week of the year to `gasDay`, oldest first. */
  trail: Array<{ date: string; value: number }>;
}

export interface GasStorageBoard {
  generatedAt: string;
  status: "available" | "unavailable";
  units: GasStorageUnits;
  source: { name: string; url: string };
  /** When every area was last read from the platform. */
  checkedAt: string | null;
  gaps: string[];
  /** The EU aggregate first, then the member states by name. */
  rows: GasStorageRow[];
}

export interface GasStorageHistory {
  code: string;
  name: string;
  units: GasStorageUnits;
  source: { name: string; url: string };
  /** Every gas day with a reading, oldest first; a missing figure is null, never zero. */
  points: Array<{
    date: string;
    status: GasReadingStatus;
    full: number | null;
    gasInStorage: number | null;
    workingGasVolume: number | null;
    injection: number | null;
    withdrawal: number | null;
  }>;
}

/** The latest gas day's calendar year against last year and the five years before, on that year's calendar. */
export interface GasStorageSeasonal {
  code: string;
  name: string;
  unit: "%";
  source: { name: string; url: string };
  year: number | null;
  /** The band years holding any reading. */
  years: number[];
  current: Array<[string, number]>;
  previous: Array<[string, number]>;
  /** [date, min, average, max, years with a reading]. */
  band: Array<[string, number | null, number | null, number | null, number]>;
}
