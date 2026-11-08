/** EF Bills, EF Notes, an HKSAR institutional Government Bond, or its HONIA-indexed floating rate note. */
type HkTenderPaper = "efb" | "efn" | "hkgb" | "hkgb-frn";

/** One tender's result, as the Hong Kong Monetary Authority's Open API states it. */
export interface HkTender {
  /** The issue day (YYYY-MM-DD), the business day after the tender; Government Bonds give only the month (YYYY-MM). */
  date: string;
  paper: HkTenderPaper;
  /** A Government Bond's issue number (10GB3507001); HKMA's EF figures name none. */
  issue: string | null;
  /** A re-opening of an issue already outstanding; null for EF paper. */
  reopening: boolean | null;
  /** HKD, or CNH for an RMB Government Bond. */
  currency: "HKD" | "CNH";
  /** A Government Bond's expected maturity (YYYY-MM). */
  maturity: string | null;
  /** "3-Month" for a bill, "2-Year" for a note, a bond's original tenor by its issue number. */
  term: string;
  /** Annual coupon in percent; null for a bill or a floating rate note. */
  coupon: number | null;
  /** The average accepted yield in percent (an RMB bond's annualised one); null for a floating rate note. */
  averageYield: number | null;
  /** An RMB bond's average accepted yield, semi-annualised. */
  averageYieldSemiAnnual: number | null;
  /** A floating rate note's spread over HONIA, in percent. */
  spread: number | null;
  /** Applications, in units of `currency`. */
  applied: number;
  /** The amount allotted: stated for Government Bonds only. */
  allotted: number | null;
  /** EF paper: applications over the amount offered, less one. */
  overSubscription: number | null;
  /** Applications over the amount allotted (bonds) or offered (EF paper). */
  bidToCover: number;
  /** EF paper's amount offered, worked out from the amount applied and the over-subscription, to three figures. */
  offered: number | null;
  /** The HKMA dataset it came from: `efb-91day`, `hkgb-rmb`. */
  dataset: string;
}

/** `GET /cloud/econ/hk-tenders`: Hong Kong government paper tender results from HKMA's Open API. */
export interface HkTendersPayload {
  authority: string;
  /** The attribution HKMA's terms ask for: "Source: HKMA". */
  credit: string;
  status: "available" | "unavailable";
  /** Newest first, issued on or after `from`, at most `limit`. */
  tenders: HkTender[];
  from: string;
  limit: number;
  truncated: boolean;
  /** The first and last issue the record holds. */
  firstTender: string | null;
  latestTender: string | null;
  /** The newest issue HKMA's figures hold, per paper: HKMA publishes them monthly. */
  runsTo: { efb: string | null; efn: string | null; hkgb: string | null };
  fetchedAt: string | null;
  stale: boolean;
}
