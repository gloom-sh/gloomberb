/**
 * Every listing of one company, as Gloom Cloud's company universe groups
 * them: share classes, a US receipt and its home line, dual listings. RCI on
 * the NYSE and RCI.B on the TSX are both Rogers Communications.
 */

/** One listing, written as the service writes it: bare on a US venue (RCI), SYMBOL:EXCHANGE elsewhere (RCI.B:TSX). */
interface IssuerListing {
  symbol: string;
  /** The canonical venue code. */
  exchange: string;
  name: string;
  /** The company's primary line. */
  primary: boolean;
}

export interface IssuerListings {
  /** The service's key for the company (cik:733099). */
  issuer: string;
  name: string;
  /**
   * Where the company is from, ISO 3166 alpha-2: its primary line's country,
   * or the SEC address of a foreign company whose only lines are in the US.
   */
  country: string;
  /** The primary line first. */
  listings: IssuerListing[];
}
