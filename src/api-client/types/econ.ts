type CloudEconImpact = "high" | "medium" | "low";

export interface CloudEconEventPayload {
  id: string;
  date: string;
  time: string;
  country: string;
  event: string;
  actual: string | null;
  forecast: string | null;
  prior: string | null;
  impact: CloudEconImpact;
  /** Rows the calendar adds beside its feeds: a central bank's kept decision or a statistics office's listed release. */
  kind?: "central-bank-decision" | "statistics-release";
  /** The publisher's own clock time and its IANA zone; null when it states no time. */
  localTime?: string | null;
  timeZone?: string;
  /** Why a row has no time, when its publisher states none. */
  timeNote?: string | null;
  priorAsOf?: string | null;
  referencePeriod?: string | null;
  /** The currency the row's amounts are in (`JPY`, `USD`), beside figures that never name it; absent from an older server. */
  currency?: string | null;
  /** Who publishes the release (Freddie Mac for the 30-year mortgage rate), and its page when one is named. */
  source?: { name: string; url?: string };
  /**
   * The indicator this release is of, the same from one release to the next
   * (`us-unemployment-rate` on every month's row), where `id` names the one
   * row. Absent from a server that names none; exports leave the column empty.
   */
  indicatorId?: string | null;
  /**
   * Where the forecast (the consensus) was read from, `week-feed` or
   * `release-calendar`, and when that feed was read. Absent on a row with no
   * forecast and on one kept before the read was recorded.
   */
  consensus?: { source: string; readAt: string } | null;
}

/** One currency's short-term rate, as GET /cloud/econ/short-rates serves it. */
export interface CloudShortRate {
  currency: string;
  /** "SOFR", "TIIE 28d". */
  name: string;
  /** "overnight" or the term the rate is for. */
  tenor: string;
  tenorDays: number;
  /** Days in the year the rate is quoted over. */
  dayCountBasis: 360 | 365;
  /**
   * "business-252": compounded over 252 business days a year (Brazil's CDI),
   * grown as (1 + r)^(days / 365), business days taken as 252/365 of the
   * calendar days. Absent: simple interest on `dayCountBasis`.
   */
  compounding?: "business-252" | null;
  publisher: string;
  sourceUrl: string;
  /** Percent a year; null when it could not be read. */
  value: number | null;
  /** The day the rate is for. */
  asOf: string | null;
  fetchedAt: string | null;
  stale: boolean;
  unavailableReason: string | null;
  /** The attribution the publisher's licence asks for wherever the rate is shown (MAS's SORA); absent otherwise. */
  attribution?: { text: string; licenceUrl: string } | null;
}

export interface CloudShortRatesPayload {
  generatedAt: string;
  rates: CloudShortRate[];
}

/** CPI, payrolls and FOMC statement days as published, as GET /cloud/econ/release-days serves them. */
export interface CloudMacroReleaseDaysPayload {
  /** When the publishers' pages were read, ISO. */
  checkedAt: string;
  /** The last New York day the lists are complete for. */
  coveredThrough: string;
  sources: string[];
  /** New York dates, oldest first. Brazil's IPCA days when the server can vouch for them. */
  releases: Record<"cpi" | "jobs" | "fomc", string[]> & { ipca?: string[] };
  /** Each kind's figures by New York release day, for the days they are known. */
  figures?: Partial<Record<"cpi" | "jobs" | "fomc" | "ipca", Record<string, {
    event: string;
    actual: string | null;
    forecast: string | null;
    prior: string | null;
    /** Above the consensus (hot), below it (cool), at it (in-line); null without both. */
    surprise: "hot" | "cool" | "in-line" | null;
  }>>>;
}

export interface CloudFredObservationPayload {
  date: string;
  value: number | null;
  /**
   * Who published a value FRED does not list yet, such as a Treasury yield
   * Gloom Cloud read from the Treasury first. Absent on FRED's own values.
   */
  publisher?: string;
  /** When that publisher's value was first read, ISO in UTC. */
  publishedAt?: string;
  /**
   * The day FRED's source released this value (`YYYY-MM-DD`), on the newest
   * observation of a weekly to annual series: September's permits are dated
   * 1 Sep and were released 20 Oct. Absent on daily series and older points.
   */
  releasedOn?: string;
}

export interface CloudFredSeriesInfoPayload {
  id: string;
  title: string;
  units: string;
  frequency: string;
  seasonalAdjustment: string;
  source: string;
  notes: string;
  lastUpdated?: string;
  observationStart?: string;
  observationEnd?: string;
}

export interface CloudFredSeriesPayload {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
  fetchedAt?: string;
  stale?: boolean;
  coverage?: { observations: "available"; info: "available" | "unavailable" };
}

/** The FRED series Gloom Cloud serves, from `GET /cloud/econ/series`; any other id is refused. */
export interface CloudFredSeriesCatalogPayload {
  series: Array<{ id: string; title?: string | null; group?: string | null }>;
}

/**
 * One month of Robert Shiller's dataset. FRED carries no long-run S&P earnings,
 * so this is what every earnings-based valuation ratio is built from.
 */
interface CloudShillerObservationPayload {
  date: string;
  price: number | null;
  dividend: number | null;
  earnings: number | null;
  cpi: number | null;
  longRate: number | null;
  cape: number | null;
  /** CAPE earnings yield over the real 10-year rate; Shiller's equity risk premium. */
  excessCapeYield: number | null;
}

export interface CloudShillerPayload {
  observations: CloudShillerObservationPayload[];
  sourceUrl: string;
  fetchedAt: string;
}

export interface CloudYieldPointPayload {
  maturity: string;
  maturityYears: number;
  yield: number | null;
  /** FRED observation date. Absent on servers older than the field. */
  asOf?: string | null;
  fetchedAt?: string;
  stale?: boolean;
}
