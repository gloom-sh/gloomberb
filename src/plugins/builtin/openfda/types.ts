export const OPENFDA_PLUGIN_ID = "openfda";
export const OPENFDA_PANE_ID = "adverse-events";
export const OPENFDA_API_BASE_URL = "https://api.fda.gov";

/** One openFDA dataset; the pane shows one at a time. */
export type OpenFdaDataset = "drug" | "device" | "recall";

/** What part a drug played in a report, as the reporter coded it. */
export type DrugRole = "suspect" | "concomitant" | "interacting";

interface OpenFdaRecordBase {
  /** Dataset plus the dataset's own id, so a report is one row however it is found. */
  id: string;
  date: Date | null;
  /** The record itself on the public API, for `o`. */
  url: string;
}

/** One FAERS report: what was taken and what the reporter saw, not a finding of cause. */
export interface DrugReport extends OpenFdaRecordBase {
  dataset: "drug";
  /** The drug in the report that the search matched, or its first suspect drug. */
  product: string;
  role: DrugRole | null;
  drugs: Array<{ name: string; role: DrugRole | null }>;
  reactions: string[];
  /** The worst reported outcome: "Death", "Serious" or "Not serious". */
  outcome: string | null;
  /** Each seriousness criterion the report ticks. */
  outcomes: string[];
  /** Only when the product has a single labeler; generics list every one. */
  manufacturer: string | null;
  reporter: string | null;
  country: string | null;
}

/** One MAUDE report about a device. */
export interface DeviceReport extends OpenFdaRecordBase {
  dataset: "device";
  product: string;
  manufacturer: string | null;
  eventType: string | null;
  model: string | null;
  productCode: string | null;
  productProblems: string[];
  patientProblems: string[];
  reportNumber: string | null;
}

/** One drug recall from the FDA enforcement report. */
export interface DrugRecall extends OpenFdaRecordBase {
  dataset: "recall";
  firm: string;
  product: string;
  reason: string | null;
  classification: string | null;
  status: string | null;
  recallNumber: string | null;
  reportDate: Date | null;
  distribution: string | null;
}

export type OpenFdaRecord = DrugReport | DeviceReport | DrugRecall;

/**
 * One page of one dataset. `matched` is what the dataset says matched the
 * search; `windowLimited` that it matched more than its paging reaches.
 */
export interface OpenFdaPage {
  rows: OpenFdaRecord[];
  hasMore: boolean;
  nextOffset: number | null;
  matched: number;
  lastUpdated: string | null;
  windowLimited: boolean;
}
