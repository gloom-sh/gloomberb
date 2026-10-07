import { apiClient } from "../../../api-client";
import type { GuidancePayload, KpiEvidence, KpiGuidance, KpiObservation, KpiPeriod, KpiQueryOptions, KpisPayload } from "../../../api-client/company-kpis";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export type CompanyDataset = KpisPayload | GuidancePayload;
export type CompanyMode = "kpis" | "guidance";
export const KPI_UNAVAILABLE = "Company disclosures are not available yet.";
export const companyKpisCache = createPluginCache<CompanyDataset>({ kind: "company-kpis", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 } });
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const date = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const instant = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const count = (value: unknown) => Number.isInteger(value) && Number(value) >= 0;
const confidence = (value: unknown) => finite(value) && value >= 0 && value <= 1;
const nullableNumber = (value: unknown) => value === null || finite(value);
const units = ["currency", "currency_per_share", "currency_per_unit", "percent", "basis_points", "count", "ratio", "volume"];
const bases = ["reported", "adjusted", "constant_currency", "organic"];
const sourceKinds = ["press_release", "filing", "transcript", "opendart", "ir", "esef", "edinet"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validPeriod(period: KpiPeriod): boolean {
  return !!period && (period.end === null || date(period.end)) && (period.start === null || date(period.start) && (period.end === null || period.start <= period.end))
    && ["quarter", "half", "year", "ytd", "instant", "other"].includes(period.kind) && text(period.label)
    && (period.fiscalYear === null || Number.isInteger(period.fiscalYear))
    && (period.fiscalQuarter === null || [1, 2, 3, 4].includes(period.fiscalQuarter));
}
function validEvidence(evidence: KpiEvidence): boolean {
  let safeUrl = false;
  try { safeUrl = ["https:", "http:"].includes(new URL(evidence.url).protocol); } catch { /* Invalid evidence cannot be opened. */ }
  return !!evidence && text(evidence.id) && text(evidence.documentId) && text(evidence.sourceId)
    && sourceKinds.includes(evidence.sourceKind) && safeUrl && text(evidence.title) && instant(evidence.publishedAt)
    && text(evidence.country) && text(evidence.language) && text(evidence.quote) && evidence.quote.trim().length > 0
    && count(evidence.quoteOffset) && Number.isInteger(evidence.quoteSourceLength) && evidence.quoteSourceLength > 0
    && ["exact", "whitespace", "nfkc_whitespace"].includes(evidence.quoteMatchMode) && confidence(evidence.confidence);
}
function validRow(row: KpiObservation | KpiGuidance): boolean {
  return !!row && text(row.id) && text(row.symbol) && text(row.metricId) && !!row.metric && row.metric.id === row.metricId
    && text(row.metric.name) && text(row.metric.definition) && units.includes(row.unit) && bases.includes(row.basis)
    && nullableText(row.currency) && (!row.unit.startsWith("currency") || !!row.currency)
    && record(row.dimensions) && Object.values(row.dimensions).every(text) && validPeriod(row.period)
    && instant(row.asOf) && text(row.seriesKey) && confidence(row.confidence) && count(row.revision)
    && nullableText(row.supersedesId) && typeof row.current === "boolean" && Array.isArray(row.evidence)
    && row.evidence.length > 0 && row.evidence.every(validEvidence);
}
function validObservation(row: KpiObservation) { return validRow(row) && finite(row.value) && typeof row.conflict === "boolean" && (row.contested === undefined || typeof row.contested === "boolean")
  && (row.valueQualifier === undefined || ["exact", "approximately", "at_least", "at_most", "greater_than", "less_than"].includes(row.valueQualifier)); }
function validGuidance(row: KpiGuidance) {
  return validRow(row) && date(row.issuedDate) && [row.low, row.high, row.point, row.midpointChangePct].every(nullableNumber)
    && (row.low === null || row.high === null || row.low <= row.high)
    && ["exact", "approximately", "at_least", "at_most", "greater_than", "less_than", "qualitative", "withdrawn"].includes(row.hedge)
    && ["active", "withdrawn"].includes(row.status) && text(row.rangeText) && nullableText(row.previousId)
    && (row.conditions === undefined || nullableText(row.conditions))
    && ["raised", "cut", "reiterated", "mixed", "initiated", "withdrawn", "not_comparable"].includes(row.direction)
    && (row.actual === null || text(row.actual.observationId) && finite(row.actual.value)
      && ["above", "below", "within"].includes(row.actual.outcome) && ["beat", "miss", "in_line", "neutral"].includes(row.actual.favorable)
      && finite(row.actual.difference) && nullableNumber(row.actual.differencePct));
}
export function validateCompanyData<T extends CompanyDataset>(data: T): T {
  const coverage = data?.coverage;
  const common = !!data && text(data.symbol) && ["available", "unavailable"].includes(data.status)
    && (data.asOf === null || instant(data.asOf)) && ["full", "preview"].includes(data.access)
    && count(data.lockedRows) && count(data.totalRows) && typeof data.truncated === "boolean"
    && (data.previewRows === null || count(data.previewRows)) && text(data.methodology)
    && !!coverage && [coverage.documents, coverage.observations, coverage.guidance, coverage.conflicts].every(count)
    && Array.isArray(coverage.languages) && coverage.languages.every(text) && Array.isArray(coverage.sourceKinds)
    && coverage.sourceKinds.every((kind) => sourceKinds.includes(kind)) && Array.isArray(data.dictionary);
  const valid = common && ("series" in data
    ? Array.isArray(data.series) && data.series.every((series) => !!series && text(series.key) && validObservation(series.latest) && series.latest.seriesKey === series.key
      && Array.isArray(series.observations) && series.observations.every((row) => validObservation(row) && row.seriesKey === series.key))
      && Array.isArray(data.revisions) && data.revisions.every(validObservation)
    : Array.isArray(data.guidance) && data.guidance.every(validGuidance) && Array.isArray(data.history) && data.history.every(validGuidance));
  if (!valid) throw new Error("The server returned unreadable company disclosures");
  return data;
}
type CompanyClient = Pick<typeof apiClient, "getCloudCompanyKpis" | "getCloudCompanyGuidance">;
export async function fetchCompanyData(mode: CompanyMode, symbol: string, options: KpiQueryOptions = {}, client: CompanyClient = apiClient) {
  try {
    const data = validateCompanyData(await (mode === "kpis" ? client.getCloudCompanyKpis(symbol, options) : client.getCloudCompanyGuidance(symbol, options)));
    if (("series" in data) !== (mode === "kpis") || data.symbol.toUpperCase() !== symbol.trim().toUpperCase()) throw new Error("Company disclosures do not match the requested company");
    return data;
  }
  catch (error) { throw unavailableOnServer(error, KPI_UNAVAILABLE, [404, 503]); }
}
export const companyQuery = (options: Record<string, unknown>): KpiQueryOptions => Object.fromEntries(["metric", "basis", "from", "to", "asOf"]
  .flatMap((key) => typeof options[key] === "string" && options[key] !== "all" ? [[key, options[key]]] : [])) as KpiQueryOptions;
// Partition paid history by both identity and entitlement, including screenshot snapshots.
const cacheKey = (mode: CompanyMode, symbol: string, access: string) => `${mode}:${symbol.toUpperCase()}:${access}`;
export const cachedCompanyData = (mode: CompanyMode, symbol: string, access: string) => cachedCloudResource(companyKpisCache, cacheKey(mode, symbol, access), validateCompanyData);
export const loadCompanyData = (mode: CompanyMode, symbol: string, access: string, force = false) => loadCloudResource(companyKpisCache,
  cacheKey(mode, symbol, access), () => fetchCompanyData(mode, symbol), { force, validate: validateCompanyData });
