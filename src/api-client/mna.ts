/**
 * Mergers and acquisitions read from news, press releases and SEC filings.
 * A deal is one target and one buyer; a target with competing bidders has a
 * deal per bidder.
 */

/** Reported talks, a signed or launched deal, or its end. */
export type MnaStatus = "talks" | "pending" | "completed" | "terminated";

export type MnaConsideration = "cash" | "stock" | "mixed" | "undisclosed";

export interface MnaParty {
  name: string;
  /** Listing symbol, suffixed outside the US (`RXL.PA`); null for a private company. */
  symbol: string | null;
  /** ISO 3166 alpha-2 country of the company's head office, when known. */
  country: string | null;
}

export interface MnaTerms {
  consideration: MnaConsideration;
  /** Cash per target share, in `currency`. */
  cashPerShare: number | null;
  /** Acquirer shares per target share. */
  exchangeRatio: number | null;
  /** The listing the exchange ratio pays in, usually the acquirer's. */
  ratioSymbol: string | null;
  currency: string | null;
  /** A contingent value right rides on top of the per-share terms. */
  cvr: boolean;
  /** The offer is for part of the shares, so the spread applies to a prorated slice. */
  partial: boolean;
}

export interface MnaDeal {
  id: string;
  target: MnaParty;
  /** Null while a sale is reported without a named buyer. */
  acquirer: MnaParty | null;
  status: MnaStatus;
  /** Where a pending deal stands, e.g. "Tender offer", "Shareholder vote". */
  stage: string | null;
  hostile: boolean;
  terms: MnaTerms;
  /** Headline transaction value in `valueCurrency`. */
  value: number | null;
  valueCurrency: string | null;
  /** The same value in US dollars, for sorting and the size filter. */
  valueUsd: number | null;
  /** Day the deal or the talks were first reported. */
  announced: string;
  /** Expected close as the parties state it, e.g. "2026-12-31" or "Q1 2027". */
  expectedClose: string | null;
  closed: string | null;
  /** One line on the latest development. */
  headline: string;
  updatedAt: string;
}

export type MnaStatusFilter = MnaStatus | "all";
export type MnaTargetFilter = "all" | "public" | "private";
export type MnaRegionFilter = "all" | "us" | "intl";

export interface MnaDealsParams {
  status?: MnaStatusFilter;
  target?: MnaTargetFilter;
  region?: MnaRegionFilter;
  /** Deals where this symbol is the target or the buyer. */
  symbol?: string;
  query?: string;
  offset?: number;
  limit?: number;
}

export interface MnaDealsPayload {
  deals: MnaDeal[];
  hasMore: boolean;
  nextOffset: number;
  /** "delayed" hides deals first reported within `delayDays` from a free account. */
  access: "full" | "delayed";
  delayDays: number;
  /** Deals the delay hides from this list. */
  lockedDeals: number;
  asOf: string;
}

export type MnaEventKind =
  | "talks"
  | "announced"
  | "amended"
  | "filing"
  | "tender"
  | "vote"
  | "regulatory"
  | "completed"
  | "terminated"
  | "update";

export interface MnaDealEvent {
  id: string;
  /** Calendar day of the event. */
  date: string;
  kind: MnaEventKind;
  title: string;
  /** SEC form or the publisher of the story. */
  source: string;
  url: string | null;
}

export interface MnaDealPayload {
  deal: MnaDeal;
  events: MnaDealEvent[];
  access: "full" | "delayed";
}
