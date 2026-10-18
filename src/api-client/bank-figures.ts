/**
 * `/cloud/bank-figures`: a US bank holding company's deposits from its own
 * 10-Q and 10-K, and its lead bank's uninsured deposits and commercial real
 * estate loans from the FDIC call report. Every figure carries the filing or
 * report it was read from. A company that is not a bank answers `bank: false`.
 */
interface BankFiling {
  form: string;
  /** YYYY-MM-DD */
  filed: string;
  accessionNumber: string;
}

interface BankDepositObservation extends BankFiling {
  /** The balance-sheet date, YYYY-MM-DD. */
  date: string;
  /** USD */
  value: number;
  /** `total`: the filing's total deposits line; `sum`: its interest-bearing and noninterest-bearing lines added. */
  basis: "total" | "sum";
}

interface BankSource {
  url: string;
  fetchedAt: string;
  sha256: string;
}

interface FdicSource extends BankSource {
  /** When the FDIC built the data served. */
  datasetAsOf: string | null;
}

export interface BankFiguresPayload {
  symbol: string;
  company: { cik: string; name: string };
  bank: boolean;
  deposits: {
    currency: "USD";
    latest: BankDepositObservation;
    previous: BankDepositObservation | null;
    sources: BankSource[];
  } | null;
  leadBank: {
    cert: number;
    name: string;
    rssd: string | null;
    state: string | null;
    holdingCompany: { name: string; rssd: string | null } | null;
    totalAssets: number | null;
    reportDate: string | null;
    otherBanks: number;
    source: FdicSource;
  } | null;
  callReport: {
    cert: number;
    /** The call report's quarter end, YYYY-MM-DD. */
    reportDate: string;
    totalDeposits: number | null;
    domesticDeposits: number | null;
    insuredDeposits: number | null;
    uninsuredDeposits: number | null;
    /** Uninsured over insured plus uninsured, 0 to 1. */
    uninsuredShare: number | null;
    cre: { constructionAndLand: number; multifamily: number; nonOwnerOccupied: number; total: number } | null;
    capital: { basis: "total risk-based capital" | "tier 1 capital"; value: number } | null;
    /** CRE over `capital`, 3 for 300%. */
    creToCapital: number | null;
    source: FdicSource;
  } | null;
  /** One sentence for each part missing while the company is a bank. */
  notes: string[];
}
