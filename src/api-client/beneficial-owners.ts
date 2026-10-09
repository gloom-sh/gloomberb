/**
 * Schedule 13D and 13G beneficial ownership reports about one issuer, as
 * `GET /cloud/sec/beneficial-owners` returns them. Percentages are percent
 * points (7.3 means 7.3% of the class) and dates are `YYYY-MM-DD`.
 */

type BeneficialOwnerKind = "13D" | "13G";
/**
 * What the filer's latest report says it holds: `below-threshold` is a
 * reported stake under 5% (still a stake, no longer reportable), `exited` a
 * report of zero shares or 0%.
 */
export type BeneficialOwnerStatus = "holder" | "below-threshold" | "exited";
/** Which reports to list; the route takes the kind in capitals. */
export type BeneficialOwnersForm = "all" | BeneficialOwnerKind;

export interface BeneficialOwnerReportingPerson {
  name: string;
  cik: string | null;
  percentOfClass: number | null;
  shares: number | null;
}

/**
 * One report: the latest per filer in `owners`, every report in `filings`.
 * The previous-report fields and `status` come only with `owners`.
 */
export interface BeneficialOwnerFiling {
  filerCik: string | null;
  filerName: string;
  /** The EDGAR form type as filed, such as `SCHEDULE 13G/A`. */
  form: string;
  kind: BeneficialOwnerKind;
  amendment: boolean;
  amendmentNo: number | null;
  percentOfClass: number | null;
  shares: number | null;
  classTitle: string | null;
  cusip: string | null;
  eventDate: string | null;
  filingDate: string;
  accessionNumber: string;
  filingUrl: string;
  /** The same filer's percentage in its report before this one. */
  previousPercent?: number | null;
  previousFilingDate?: string | null;
  status?: BeneficialOwnerStatus;
  /** `text` and `index` reports could not be read in full; their missing numbers stay null. */
  source: "xml" | "text" | "index";
  reportingPersons: BeneficialOwnerReportingPerson[];
}

export interface BeneficialOwnersCoverage {
  from: string | null;
  /** Reports listed for the issuer in the window. */
  filings: number;
  /** Reports whose cover page was read. */
  parsed: number;
  /** Reports known only from the EDGAR index: listed, with their figures missing. */
  unparsed: number;
  /** Reports that could not be read this time and are left out until a later request. */
  unavailable?: number;
}

export interface BeneficialOwnersPayload {
  ticker: string;
  cik: string;
  companyName: string;
  /** When the server assembled the list, an ISO time. */
  asOf: string | null;
  owners: BeneficialOwnerFiling[];
  /** Only when the request asked for the history. Newest first. */
  filings?: BeneficialOwnerFiling[];
  hasMore: boolean;
  nextOffset: number | null;
  coverage: BeneficialOwnersCoverage | null;
}

export interface CloudBeneficialOwnersParams {
  ticker: string;
  form?: BeneficialOwnersForm;
  history?: boolean;
  limit?: number;
  offset?: number;
}
