export const TREASURY_AUCTIONS_PANE_ID = "treasury-auctions";

/**
 * Normalized Treasury auction record. Fiscal Data returns every field as a
 * string, including the literal `"null"` for metrics an auction does not
 * report, so numbers are parsed once here.
 */
export interface TreasuryAuction {
  /** cusip | auction_date, or security_type | auction_date | security_term when the feed omits a CUSIP. */
  id: string;
  /** Security identifier; a reopening repeats the original issue's CUSIP. */
  cusip: string | null;
  /** "Bill", "Note", "Bond", "CMB", "FRN", "TIPS". */
  secType: string;
  /** "4-Week", "2-Year", "29-Year 6-Month". */
  securityTerm: string;
  /** ISO "YYYY-MM-DD". */
  auctionDate: string;
  /** High investment rate, reported by Bills and FRNs. */
  highInvestmentRate: number | null;
  /** High yield, reported by Notes, Bonds, and TIPS. */
  highYield: number | null;
  avgMedYield: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  avgMedPrice: number | null;
  bidToCoverRatio: number | null;
  /** Competitive accepted dollar amount. */
  competitiveAccepted: number | null;
  /** Indirect bidder accepted dollars (foreign central banks and similar). */
  indirectAccepted: number | null;
  /** Primary dealer accepted dollars. */
  primaryDealerAccepted: number | null;
  totalAccepted: number | null;
  /** Offering amount announced before the auction. */
  offeringAmount: number | null;
}

/** Raw shape returned by the Fiscal Data auctions_query endpoint. */
export interface TreasuryAuctionRaw {
  cusip?: string;
  security_type?: string;
  security_term?: string;
  auction_date?: string;
  high_investment_rate?: string;
  high_yield?: string;
  avg_med_yield?: string;
  high_price?: string;
  low_price?: string;
  avg_med_price?: string;
  bid_to_cover_ratio?: string;
  comp_accepted?: string;
  indirect_bidder_accepted?: string;
  primary_dealer_accepted?: string;
  total_accepted?: string;
  offering_amt?: string;
}

export type LoadStatus = "idle" | "loading" | "loaded" | "error";
