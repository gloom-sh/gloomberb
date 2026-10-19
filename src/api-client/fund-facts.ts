/** One published figure: when it is as of and who published it (the fund's sponsor, or Gloom Cloud for a computed one). */
interface FundFact<T> {
  value: T;
  asOf: string | null;
  source: string;
  url?: string;
}

type FundStructure = "registered" | "trust";
type ExpenseRatioKind = "net" | "gross" | "sponsor-fee";
/**
 * A bond fund as its sponsor classes it: `municipal` when its interest is
 * exempt from federal income tax, `taxable` otherwise.
 */
type BondFundClass = "municipal" | "taxable";

/**
 * What a bond fund's sponsor publishes about its yield and rate risk, each
 * figure dated. The 30-day SEC yield is the standardized yield (net
 * investment income of the last 30 days, annualized, over the offering
 * price); a distribution yield annualizes cash paid and is not it.
 */
export interface FundBondFacts {
  kind: BondFundClass;
  /** A single-state municipal fund's state (`CA`, `NY`); null for a national fund. */
  state: string | null;
  /** Percent. */
  secYield: FundFact<number> | null;
  /** Percent. */
  yieldToWorst: FundFact<number> | null;
  /** Years: `effective` (option-adjusted) duration, or Vanguard's month-end `average` duration. */
  duration: (FundFact<number> & { measure: "effective" | "average" }) | null;
}

/**
 * `not-collected-yet`: a source Gloom reads covers the fund, but it has no
 * figures yet. `not-published`: no source Gloom reads covers it. Servers
 * before statuses leave it out.
 */
type FundFactsStatus = "covered" | "not-collected-yet" | "not-published" | "not-a-fund";

/** GET /cloud/fund-facts/:ticker. Percent fields are in percent (0.03 is 0.03%). */
export interface FundFactsPayload {
  ticker: string;
  covered: boolean;
  status?: FundFactsStatus;
  /** Why there are no facts, when `covered` is false. */
  reason?: string;
  name: string | null;
  /** `trust`: an exchange-traded trust or pool outside the 1940 Act, charging a sponsor fee. */
  structure: FundStructure | null;
  /** `document`: read from the fund's prospectus filed with the SEC on `asOf`, not from its sponsor. */
  expenseRatio: (FundFact<number> & { kind: ExpenseRatioKind; document?: "prospectus" }) | null;
  nav: FundFact<number> | null;
  closingPrice: FundFact<number> | null;
  /** `published` by the sponsor, or `computed` from the closing price against the NAV. */
  premiumDiscount: (FundFact<number> & { basis: "published" | "computed" }) | null;
  /**
   * `period`: a `day`'s figure, or the last `month-end`'s (Vanguard and ARK
   * ETFs, N-PORT), which is not today's. `document`: the fund's N-PORT report
   * to the SEC for that month end.
   */
  netAssets: (FundFact<number> & { scope: "share-class" | "fund" | null; period?: "day" | "month-end"; document?: "N-PORT" }) | null;
  sponsor: FundFact<string> | null;
  inception: FundFact<string> | null;
  index: FundFact<string> | null;
  /** A bond fund's SEC yield, yield to worst and duration; null for any other fund. Servers before it leave it out. */
  bond?: FundBondFacts | null;
  /** The newest NAV is older than a few US trading days: every figure is older than it looks. */
  stale: boolean;
  fetchedAt: string | null;
}
