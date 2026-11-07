/** One day Japan's Ministry of Finance intervened, in one pair, as its quarterly release lists it. */
export interface FxInterventionDay {
  /** The day, in Tokyo. */
  date: string;
  /** The day's total in yen; an operation in a pair without the yen is converted at the Bank of Japan's central rate. */
  amountJpy: number;
  /** The currency sold and the one bought (ISO codes); null for one the server does not list. */
  sold: string | null;
  bought: string | null;
  /** The pair as the ministry writes it: "the US dollar (sold) the Japanese yen (bought)". */
  pair: string;
}

/** One monthly release: the total for its period, which names no day and no pair. */
export interface FxInterventionPeriod {
  from: string;
  to: string;
  amountJpy: number;
  /** The day the ministry published it. */
  releasedOn?: string;
  url?: string;
}

/** `GET /cloud/econ/fx-interventions`: Japan's interventions as the Ministry of Finance publishes them. */
export interface FxInterventionsPayload {
  authority: string;
  status: "available" | "unavailable";
  /** Each operation, oldest first. */
  days: FxInterventionDay[];
  /** The last day `days` covers; a monthly total after it names no day yet. */
  dailyThrough: string | null;
  /** Every monthly release read, oldest first. */
  months: FxInterventionPeriod[];
  /** Quarterly totals, oldest first. */
  quarters: FxInterventionPeriod[];
  fetchedAt: string | null;
  sourceUrl: string;
  notes: string[];
}
