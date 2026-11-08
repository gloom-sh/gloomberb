/** EF Bills, EF Notes, an HKSAR Institutional Government Bond, or its HONIA-indexed floating rate note. */
type HkTenderPaper = "efb" | "efn" | "hkgb" | "hkgb-frn";

/** One tender's competitive result, as the Hong Kong Monetary Authority's press release states it. */
export interface HkTender {
  /** The day of the tender, in Hong Kong. */
  tenderDate: string;
  paper: HkTenderPaper;
  /** The issue number as HKMA prints it: Q2644 (a three-month bill), 02Y2808, 10GB3507001. */
  issue: string;
  /** A re-opening of an issue already outstanding. */
  reopening: boolean;
  /** The exchange's stock code of a Government Bond or note, null for EF paper. */
  stockCode: string | null;
  /** HKD, or CNH for an RMB Government Bond. */
  currency: "HKD" | "CNH";
  issueDate: string | null;
  maturityDate: string | null;
  /** "3-Month" for a bill, "10-Year" for a note or bond. */
  term: string;
  /** Calendar days from issue to maturity. */
  days: number | null;
  /** Annual coupon in percent; null for a bill or a floating rate note. */
  coupon: number | null;
  /** Competitive applications and the amount allotted, in units of `currency`. */
  applied: number | null;
  allotted: number | null;
  /** Applications over the amount allotted. */
  bidToCover: number | null;
  /** The average and highest accepted yields, in percent. */
  averageYield: number | null;
  highestYield: number | null;
  averagePrice: number | null;
  lowestPrice: number | null;
  /** The average yield of every bid, accepted or not. */
  averageTenderYield: number | null;
  /** A floating rate note's average and highest accepted spreads over HONIA, in percent. */
  averageSpread: number | null;
  highestSpread: number | null;
  /** The share, in percent, of each bid at the highest accepted yield that was allotted. */
  proRata: number | null;
  /** The press release, and the day HKMA published it. */
  url: string;
  publishedOn: string;
}

/** `GET /cloud/econ/hk-tenders`: Hong Kong government paper tender results as HKMA publishes them. */
export interface HkTendersPayload {
  authority: string;
  status: "available" | "unavailable";
  /** Newest first, from `from` when the request named one. */
  tenders: HkTender[];
  firstTender: string | null;
  latestTender: string | null;
  fetchedAt: string | null;
  stale: boolean;
}
