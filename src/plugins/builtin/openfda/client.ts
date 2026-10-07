import { httpFetch } from "../../../utils/http-transport";
import { createThrottledFetch } from "../../../utils/throttled-fetch";
import {
  OPENFDA_API_BASE_URL,
  type DeviceReport,
  type DrugRecall,
  type DrugReport,
  type DrugRole,
  type OpenFdaDataset,
  type OpenFdaPage,
  type OpenFdaRecord,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 50;
/** openFDA refuses to skip past this many records. */
const MAX_SKIP = 25_000;

// Without a key openFDA allows 240 requests a minute and 1,000 a day per
// address, so stay well under the minute limit and send nothing speculative.
const openFdaFetch = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  backoffBaseMs: 500,
  dedupeGetRequests: true,
  defaultHeaders: {
    Accept: "application/json",
    "User-Agent": "gloomberb-openfda",
  },
  transport: (url: string, init?: RequestInit) => httpFetch(url, init),
});

/**
 * An optional key from OPENFDA_API_KEY raises those limits. It goes in the
 * Authorization header, which openFDA accepts, so it is never part of a URL
 * the app shows, caches or reports.
 */
function authorizationHeaders(): Record<string, string> {
  const key = typeof process === "undefined" ? undefined : process.env.OPENFDA_API_KEY?.trim();
  return key ? { Authorization: `Basic ${btoa(`${key}:`)}` } : {};
}

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asString).filter((entry): entry is string => !!entry) : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const usable = (value: string | undefined): string | undefined =>
  value && !/^(n\/?a|unknown|ni|une)$/i.test(value) ? value : undefined;

// openFDA dates are YYYYMMDD; device dates are sometimes YYYY-MM-DD.
export function parseOpenFdaDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.replace(/-/g, ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

const normalizeWords = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The search's words appear together in one of the fields, as openFDA matches a phrase. */
function fieldsMatch(fields: Array<string | undefined>, query: string): boolean {
  const words = normalizeWords(query);
  if (!words) return false;
  return fields.some((field) => !!field && ` ${normalizeWords(field)} `.includes(` ${words} `));
}

const quoted = (query: string): string => `"${query.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;

// Drug reports are searched by drug name only. Their manufacturer field lists
// every firm that labels the product (a generic has dozens), so a firm name
// would match reports of other companies' drugs.
const SEARCH_FIELDS: Record<OpenFdaDataset, string[]> = {
  drug: [
    "patient.drug.medicinalproduct",
    "patient.drug.openfda.brand_name",
    "patient.drug.openfda.generic_name",
  ],
  device: ["device.brand_name", "device.generic_name", "device.manufacturer_d_name"],
  recall: ["recalling_firm", "product_description", "reason_for_recall"],
};

const DATASET_PATH: Record<OpenFdaDataset, string> = {
  drug: "/drug/event.json",
  device: "/device/event.json",
  recall: "/drug/enforcement.json",
};

const DATASET_SORT: Record<OpenFdaDataset, string> = {
  drug: "receivedate:desc",
  device: "date_received:desc",
  recall: "recall_initiation_date:desc",
};

/**
 * One page of a dataset, newest first. The search clauses are joined with
 * spaces, which the query string encodes as `+`: a literal `+OR+` arrives
 * as `%2BOR%2B` and matches nothing. The parentheses matter too: without
 * them three recall clauses matched 4 records where the firm alone matched 156.
 */
export function buildOpenFdaUrl(dataset: OpenFdaDataset, query: string, offset = 0): string {
  const params = new URLSearchParams();
  const text = query.trim();
  if (text) params.set("search", `(${SEARCH_FIELDS[dataset].map((field) => `${field}:${quoted(text)}`).join(" OR ")})`);
  params.set("sort", DATASET_SORT[dataset]);
  params.set("limit", String(PAGE_SIZE));
  if (offset > 0) params.set("skip", String(Math.min(offset, MAX_SKIP)));
  return `${OPENFDA_API_BASE_URL}${DATASET_PATH[dataset]}?${params.toString()}`;
}

const recordUrl = (dataset: OpenFdaDataset, field: string, id: string): string =>
  `${OPENFDA_API_BASE_URL}${DATASET_PATH[dataset]}?${new URLSearchParams({ search: `${field}:"${id}"`, limit: "1" }).toString()}`;

const DRUG_ROLES: Record<string, DrugRole> = { "1": "suspect", "2": "concomitant", "3": "interacting" };
const REPORTERS: Record<string, string> = {
  "1": "Physician",
  "2": "Pharmacist",
  "3": "Other health professional",
  "4": "Lawyer",
  "5": "Consumer",
};
const SERIOUSNESS: Array<[string, string]> = [
  ["seriousnessdeath", "Death"],
  ["seriousnesslifethreatening", "Life-threatening"],
  ["seriousnesshospitalization", "Hospitalization"],
  ["seriousnessdisabling", "Disability"],
  ["seriousnesscongenitalanomali", "Congenital anomaly"],
  ["seriousnessother", "Other serious"],
];

/**
 * A FAERS report as the search found it. Reports list every drug the patient
 * took, so the row names the drug the search matched, with the reporter's
 * role for it, rather than whichever drug happens to come first.
 */
export function parseDrugReport(raw: unknown, query = ""): DrugReport | null {
  const report = asRecord(raw);
  const id = asString(report.safetyreportid);
  if (!id) return null;
  const patient = asRecord(report.patient);
  const drugs = (Array.isArray(patient.drug) ? patient.drug : []).map(asRecord).map((drug) => {
    const openfda = asRecord(drug.openfda);
    const brand = asStringArray(openfda.brand_name);
    const generic = asStringArray(openfda.generic_name);
    const manufacturers = asStringArray(openfda.manufacturer_name);
    const name = asString(drug.medicinalproduct) ?? brand[0] ?? generic[0] ?? "Unnamed drug";
    return {
      name,
      role: DRUG_ROLES[asString(drug.drugcharacterization) ?? ""] ?? null,
      manufacturers: [...new Set(manufacturers)],
      matched: fieldsMatch([asString(drug.medicinalproduct), ...brand, ...generic], query),
    };
  });
  const shown = drugs.find((drug) => drug.matched) ?? drugs.find((drug) => drug.role === "suspect") ?? drugs[0];
  const outcomes = SERIOUSNESS.filter(([field]) => asString(report[field]) === "1").map(([, label]) => label);
  const serious = asString(report.serious);
  const outcome = outcomes.includes("Death") ? "Death" : serious === "1" ? "Serious" : serious === "2" ? "Not serious" : null;
  const primary = asRecord(report.primarysource);
  return {
    dataset: "drug",
    id: `drug:${id}`,
    date: parseOpenFdaDate(report.receivedate ?? report.receiptdate),
    url: recordUrl("drug", "safetyreportid", id),
    product: shown?.name ?? "Unnamed drug",
    role: shown?.role ?? null,
    drugs: drugs.map(({ name, role }) => ({ name, role })),
    reactions: (Array.isArray(patient.reaction) ? patient.reaction : [])
      .map((entry) => asString(asRecord(entry).reactionmeddrapt))
      .filter((entry): entry is string => !!entry),
    outcome,
    outcomes,
    manufacturer: shown && shown.manufacturers.length === 1 ? shown.manufacturers[0]! : null,
    reporter: REPORTERS[asString(primary.qualification) ?? ""] ?? null,
    country: asString(report.occurcountry) ?? asString(primary.reportercountry) ?? null,
  };
}

/** A MAUDE report, naming the device the search matched when it lists several. */
export function parseDeviceReport(raw: unknown, query = ""): DeviceReport | null {
  const report = asRecord(raw);
  const key = asString(report.mdr_report_key) ?? asString(report.report_number);
  if (!key) return null;
  const devices = (Array.isArray(report.device) ? report.device : []).map(asRecord);
  const shown = devices.find((device) => fieldsMatch(
    [asString(device.brand_name), asString(device.generic_name), asString(device.manufacturer_d_name)],
    query,
  )) ?? devices[0] ?? {};
  const patientProblems = (Array.isArray(report.patient) ? report.patient : [])
    .flatMap((patient) => asStringArray(asRecord(patient).patient_problems));
  return {
    dataset: "device",
    id: `device:${key}`,
    date: parseOpenFdaDate(report.date_received ?? report.date_added),
    url: recordUrl("device", asString(report.mdr_report_key) ? "mdr_report_key" : "report_number", key),
    product: usable(asString(shown.brand_name)) ?? usable(asString(shown.generic_name)) ?? "Unnamed device",
    manufacturer: usable(asString(shown.manufacturer_d_name)) ?? null,
    eventType: usable(asString(report.event_type)) ?? null,
    model: usable(asString(shown.model_number)) ?? null,
    productCode: asString(shown.device_report_product_code) ?? null,
    productProblems: asStringArray(report.product_problems),
    patientProblems: [...new Set(patientProblems)],
    reportNumber: asString(report.report_number) ?? null,
  };
}

/** A short, stable fingerprint, for recalls that carry no recall number. */
function fingerprint(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * One enforcement record. Records without a recall number ("N/A") are told
 * apart by their recall event and product, not lumped under one id.
 */
export function parseDrugRecall(raw: unknown): DrugRecall | null {
  const report = asRecord(raw);
  const recallNumber = usable(asString(report.recall_number)) ?? null;
  const product = asString(report.product_description) ?? "";
  const eventId = asString(report.event_id);
  if (!recallNumber && !eventId && !product) return null;
  const id = recallNumber ?? `${eventId ?? "event"}:${fingerprint(`${product}|${asString(report.code_info) ?? ""}`)}`;
  return {
    dataset: "recall",
    id: `recall:${id}`,
    date: parseOpenFdaDate(report.recall_initiation_date ?? report.center_classification_date ?? report.report_date),
    url: recallNumber
      ? recordUrl("recall", "recall_number", recallNumber)
      : recordUrl("recall", "event_id", eventId ?? ""),
    firm: asString(report.recalling_firm) ?? "Unnamed firm",
    product: product || "Product not described",
    reason: asString(report.reason_for_recall) ?? null,
    classification: usable(asString(report.classification)) ?? null,
    status: asString(report.status) ?? null,
    recallNumber,
    reportDate: parseOpenFdaDate(report.report_date),
    distribution: asString(report.distribution_pattern) ?? null,
  };
}

function parseRecord(dataset: OpenFdaDataset, raw: unknown, query: string): OpenFdaRecord | null {
  if (dataset === "drug") return parseDrugReport(raw, query);
  if (dataset === "device") return parseDeviceReport(raw, query);
  return parseDrugRecall(raw);
}

/** One page of a dataset's answer, with what it says matched and how far paging reaches. */
export function parseOpenFdaPage(dataset: OpenFdaDataset, payload: unknown, query: string, offset: number): OpenFdaPage {
  const data = asRecord(payload);
  const raw = Array.isArray(data.results) ? data.results : [];
  const meta = asRecord(data.meta);
  const total = asRecord(meta.results).total;
  const matched = typeof total === "number" && Number.isFinite(total) ? total : offset + raw.length;
  const rows = raw.map((entry) => parseRecord(dataset, entry, query)).filter((row): row is OpenFdaRecord => !!row);
  const nextOffset = offset + raw.length;
  const reachable = Math.min(matched, MAX_SKIP + PAGE_SIZE);
  const hasMore = raw.length > 0 && nextOffset < reachable;
  return {
    rows,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    matched,
    lastUpdated: asString(meta.last_updated) ?? null,
    windowLimited: !hasMore && nextOffset >= reachable && matched > reachable,
  };
}

export class OpenFdaClient {
  /** A page of one dataset. No match is an empty page; any other failure throws. */
  async listPage(dataset: OpenFdaDataset, query: string, offset: number, signal?: AbortSignal): Promise<OpenFdaPage> {
    const response = await openFdaFetch.fetch(buildOpenFdaUrl(dataset, query, offset), {
      headers: authorizationHeaders(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]) : undefined,
    });
    // openFDA answers a search with no matches with a 404.
    if (response.status === 404) {
      return { rows: [], hasMore: false, nextOffset: null, matched: 0, lastUpdated: null, windowLimited: false };
    }
    if (!response.ok) throw new Error(openFdaFailure(response.status));
    return parseOpenFdaPage(dataset, await response.json(), query, offset);
  }
}

function openFdaFailure(status: number): string {
  if (status === 429) return "FDA data is rate limited; try again in a minute";
  if ((status === 401 || status === 403) && authorizationHeaders().Authorization) {
    return "FDA data refused the request; check OPENFDA_API_KEY";
  }
  return `FDA data request failed (${status})`;
}
