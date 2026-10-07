import { httpFetch } from "../../../utils/http-transport";
import { createThrottledFetch } from "../../../utils/throttled-fetch";

const DEFAULT_PAGE_SIZE = 25;
/** Only the parts of a study the pane reads; a full record is about 16 KB. */
const STUDY_FIELDS = [
  "protocolSection.identificationModule",
  "protocolSection.statusModule",
  "protocolSection.sponsorCollaboratorsModule.leadSponsor",
  "protocolSection.designModule.studyType",
  "protocolSection.designModule.phases",
  "protocolSection.designModule.enrollmentInfo",
  "protocolSection.conditionsModule.conditions",
  "protocolSection.descriptionModule.briefSummary",
].join(",");
const CLINICAL_TRIALS_API_BASE_URL = "https://clinicaltrials.gov/api/v2";
const CLINICAL_TRIALS_STUDY_BASE_URL = "https://clinicaltrials.gov/study";

const trialsFetch = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: 15_000,
  backoffBaseMs: 500,
  dedupeGetRequests: true,
  defaultHeaders: {
    Accept: "application/json",
    "User-Agent": "gloomberb-clinical-trials",
  },
  transport: (url: string, init?: RequestInit) => httpFetch(url, init),
});

/** A single clinical study from the ClinicalTrials.gov API v2. */
export interface ClinicalTrial {
  /** NCT identifier, e.g. "NCT05123456". */
  nctId: string;
  /** Brief title shown in the table. */
  title: string;
  officialTitle: string;
  /** Raw overall status, e.g. "RECRUITING". */
  status: string;
  /** Raw phase codes, e.g. ["PHASE3"]. */
  phases: string[];
  /** Lead sponsor name. */
  sponsor: string;
  /** Lead sponsor class, e.g. "INDUSTRY". */
  sponsorClass: string;
  conditions: string[];
  summary: string;
  studyType: string;
  enrollment: number | null;
  startDate: Date | null;
  startDatePrecision?: DatePrecision;
  /** The registry's date type: an actual date or the sponsor's estimate. */
  startDateType?: TrialDateType;
  /** When the last participant was examined for the primary outcome. */
  primaryCompletionDate: Date | null;
  primaryCompletionDatePrecision?: DatePrecision;
  primaryCompletionDateType?: TrialDateType;
  completionDate: Date | null;
  completionDatePrecision?: DatePrecision;
  completionDateType?: TrialDateType;
  firstSubmitDate: Date | null;
  /** When the registry first posted the study. */
  firstPostDate: Date | null;
  /** Deep link to the study page for [o]pen. */
  url: string;
}

export type DatePrecision = "year" | "month" | "day";
export type TrialDateType = "ACTUAL" | "ESTIMATED";

/** A page of clinical trial results. */
export interface ClinicalTrialsPage {
  trials: ClinicalTrial[];
  /** Opaque cursor for the next page; null on the last one. */
  nextPageToken: string | null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? asString(item) : undefined))
    .filter((item): item is string => item !== undefined);
}

function asCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function datePrecision(value: unknown): DatePrecision {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{4}$/.test(text) ? "year" : /^\d{4}-\d{2}$/.test(text) ? "month" : "day";
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function moduleOf(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function dateType(value: unknown): TrialDateType | undefined {
  return value === "ACTUAL" || value === "ESTIMATED" ? value : undefined;
}

/** A `{ date, type }` date struct, keeping the precision the registry gave. */
function trialDate(struct: Record<string, unknown>) {
  const date = asDate(struct.date);
  return {
    date,
    ...(date ? { precision: datePrecision(struct.date), type: dateType(struct.type) } : {}),
  };
}

/**
 * Parse one v2 study record (`{ protocolSection: { ... } }`) into a trial.
 * Returns null when the record has no NCT id.
 */
export function parseClinicalTrial(raw: unknown): ClinicalTrial | null {
  if (!raw || typeof raw !== "object") return null;
  const study = raw as Record<string, unknown>;
  const protocol = moduleOf(study, "protocolSection");
  const identification = moduleOf(protocol, "identificationModule");
  const nctId = asString(identification.nctId);
  if (!nctId) return null;

  const statusModule = moduleOf(protocol, "statusModule");
  const sponsors = moduleOf(protocol, "sponsorCollaboratorsModule");
  const leadSponsor = moduleOf(sponsors, "leadSponsor");
  const design = moduleOf(protocol, "designModule");
  const conditionsModule = moduleOf(protocol, "conditionsModule");
  const description = moduleOf(protocol, "descriptionModule");
  const enrollmentInfo = moduleOf(design, "enrollmentInfo");

  const start = trialDate(moduleOf(statusModule, "startDateStruct"));
  const primaryCompletion = trialDate(moduleOf(statusModule, "primaryCompletionDateStruct"));
  const completion = trialDate(moduleOf(statusModule, "completionDateStruct"));
  const briefTitle = asString(identification.briefTitle)
    ?? asString(identification.officialTitle)
    ?? nctId;

  return {
    nctId,
    title: briefTitle,
    officialTitle: asString(identification.officialTitle) ?? briefTitle,
    status: asString(statusModule.overallStatus) ?? "UNKNOWN",
    phases: asStringArray(design.phases),
    sponsor: asString(leadSponsor.name) ?? "Unknown sponsor",
    sponsorClass: asString(leadSponsor.class) ?? "",
    conditions: asStringArray(conditionsModule.conditions),
    summary: asString(description.briefSummary) ?? "",
    studyType: asString(design.studyType) ?? "",
    enrollment: asCount(enrollmentInfo.count),
    startDate: start.date,
    startDatePrecision: start.precision,
    startDateType: start.type,
    primaryCompletionDate: primaryCompletion.date,
    primaryCompletionDatePrecision: primaryCompletion.precision,
    primaryCompletionDateType: primaryCompletion.type,
    completionDate: completion.date,
    completionDatePrecision: completion.precision,
    completionDateType: completion.type,
    firstSubmitDate: asDate(statusModule.studyFirstSubmitDate),
    firstPostDate: asDate(moduleOf(statusModule, "studyFirstPostDateStruct").date),
    url: `${CLINICAL_TRIALS_STUDY_BASE_URL}/${nctId}`,
  };
}

/** Parse a v2 `studies` response payload into a page. Pure: no network. */
export function parseClinicalTrialsPage(payload: unknown): ClinicalTrialsPage {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const studies = Array.isArray(record.studies) ? record.studies : [];
  const trials = studies
    .map((raw) => parseClinicalTrial(raw))
    .filter((trial): trial is ClinicalTrial => trial !== null);
  return { trials, nextPageToken: asString(record.nextPageToken) ?? null };
}

export interface StudiesQuery {
  /** Free-text search (`query.term`). */
  term?: string;
  /** Sponsor/company filter (`query.spons`). */
  sponsor?: string;
  pageSize?: number;
  /** The previous page's `nextPageToken`; without it, the first page. */
  pageToken?: string;
}

/**
 * Build the v2 studies URL. Pure: no network, no API key. The most recently
 * posted studies come first, the order the pane lists them in, so each page
 * continues the one before it.
 */
export function buildStudiesUrl(query: StudiesQuery = {}): string {
  const params = new URLSearchParams();
  params.set("format", "json");
  params.set("pageSize", String(query.pageSize ?? DEFAULT_PAGE_SIZE));
  params.set("sort", "StudyFirstPostDate:desc");
  params.set("fields", STUDY_FIELDS);
  const term = query.term?.trim();
  if (term) params.set("query.term", term);
  const sponsor = query.sponsor?.trim();
  if (sponsor) params.set("query.spons", sponsor);
  if (query.pageToken) params.set("pageToken", query.pageToken);
  return `${CLINICAL_TRIALS_API_BASE_URL}/studies?${params.toString()}`;
}

export class ClinicalTrialsClient {
  /**
   * Search studies on ClinicalTrials.gov v2. No API key required.
   * The pane passes its search box as `term`; callers tracking one
   * company pass `sponsor` (mapped to `query.spons`).
   */
  async listTrials(query: StudiesQuery, signal?: AbortSignal): Promise<ClinicalTrialsPage> {
    const response = await trialsFetch.fetch(buildStudiesUrl(query), { signal });
    if (!response.ok) {
      throw new Error(
        `ClinicalTrials.gov request failed: ${response.status} ${response.statusText}`,
      );
    }
    return parseClinicalTrialsPage((await response.json()) as unknown);
  }
}
