/** One published figure: when it is as of and who published it (the fund's sponsor, or Gloom Cloud for a computed one). */
export interface FundFact<T> {
  value: T;
  asOf: string | null;
  source: string;
  url?: string;
}

export type FundStructure = "registered" | "trust";
export type ExpenseRatioKind = "net" | "gross" | "sponsor-fee";

/** GET /cloud/fund-facts/:ticker. Percent fields are in percent (0.03 is 0.03%). */
export interface FundFactsPayload {
  ticker: string;
  covered: boolean;
  /** Why there are no facts, when `covered` is false. */
  reason?: string;
  name: string | null;
  /** `trust`: an exchange-traded trust or pool outside the 1940 Act, charging a sponsor fee. */
  structure: FundStructure | null;
  expenseRatio: (FundFact<number> & { kind: ExpenseRatioKind }) | null;
  nav: FundFact<number> | null;
  closingPrice: FundFact<number> | null;
  /** `published` by the sponsor, or `computed` from the closing price against the NAV. */
  premiumDiscount: (FundFact<number> & { basis: "published" | "computed" }) | null;
  netAssets: (FundFact<number> & { scope: "share-class" | "fund" | null }) | null;
  sponsor: FundFact<string> | null;
  inception: FundFact<string> | null;
  index: FundFact<string> | null;
  stale: boolean;
  fetchedAt: string | null;
}
