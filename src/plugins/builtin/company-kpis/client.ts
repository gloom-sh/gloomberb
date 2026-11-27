import { apiClient } from "../../../api-client";
import type { GuidancePayload, KpiEvidence, KpiGuidance, KpiObservation, KpiPeriod, KpiQueryOptions, KpisPayload } from "../../../api-client/company-kpis";
import { listingAbroad, type IssuerListingParams, type ListingAbroad } from "../../../api-client/paths";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { isCalendarDay, isFiniteNumber, isFraction, isHttpUrl, isIsoInstant, isNonEmptyText, isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isNullableIsoInstant, isNullableString, isRecord, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

export type CompanyDataset = KpisPayload | GuidancePayload;
export type CompanyMode = "kpis" | "guidance";
export const KPI_UNAVAILABLE = "Company disclosures are not available yet.";
const text = (value: unknown): value is string => typeof value === "string";
const units = ["currency", "currency_per_share", "currency_per_unit", "percent", "basis_points", "count", "ratio", "volume"];
const bases = ["reported", "adjusted", "constant_currency", "organic"];
function validPeriod(period: KpiPeriod): boolean {
  return !!period && isNullableCalendarDay(period.end) && (period.start === null || isCalendarDay(period.start) && (period.end === null || period.start <= period.end))
    && ["quarter", "half", "year", "ytd", "instant", "other"].includes(period.kind) && text(period.label)
    && (period.fiscalYear === null || Number.isInteger(period.fiscalYear))
    && (period.fiscalQuarter === null || [1, 2, 3, 4].includes(period.fiscalQuarter));
}
function validEvidence(evidence: KpiEvidence): boolean {
  return !!evidence && text(evidence.id) && text(evidence.documentId) && text(evidence.sourceId)
    && isNonEmptyText(evidence.sourceKind) && isHttpUrl(evidence.url) && text(evidence.title) && isIsoInstant(evidence.publishedAt)
    && text(evidence.country) && text(evidence.language) && isNonEmptyText(evidence.quote)
    && isNonNegativeInt(evidence.quoteOffset) && Number.isInteger(evidence.quoteSourceLength) && evidence.quoteSourceLength > 0
    && ["exact", "whitespace", "nfkc_whitespace"].includes(evidence.quoteMatchMode) && isFraction(evidence.confidence);
}
function validRow(row: KpiObservation | KpiGuidance): boolean {
  return !!row && text(row.id) && text(row.symbol) && text(row.metricId) && !!row.metric && row.metric.id === row.metricId
    && text(row.metric.name) && text(row.metric.definition) && units.includes(row.unit) && bases.includes(row.basis)
    && isNullableString(row.currency) && (!row.unit.startsWith("currency") || !!row.currency)
    && isRecord(row.dimensions) && Object.values(row.dimensions).every(text) && validPeriod(row.period)
    && isIsoInstant(row.asOf) && text(row.seriesKey) && isFraction(row.confidence) && isNonNegativeInt(row.revision)
    && isNullableString(row.supersedesId) && typeof row.current === "boolean" && Array.isArray(row.evidence)
    && row.evidence.length > 0 && row.evidence.every(validEvidence);
}
function validObservation(row: KpiObservation) { return validRow(row) && isFiniteNumber(row.value) && typeof row.conflict === "boolean" && (row.contested === undefined || typeof row.contested === "boolean")
  && (row.valueQualifier === undefined || ["exact", "approximately", "at_least", "at_most", "greater_than", "less_than"].includes(row.valueQualifier)); }
function validGuidance(row: KpiGuidance) {
  return validRow(row) && isCalendarDay(row.issuedDate) && [row.low, row.high, row.point, row.midpointChangePct].every(isNullableFinite)
    && (row.low === null || row.high === null || row.low <= row.high)
    && ["exact", "approximately", "at_least", "at_most", "greater_than", "less_than", "qualitative", "withdrawn"].includes(row.hedge)
    && ["active", "withdrawn"].includes(row.status) && text(row.rangeText) && isNullableString(row.previousId)
    && (row.conditions === undefined || isNullableString(row.conditions))
    && ["raised", "cut", "reiterated", "mixed", "initiated", "withdrawn", "not_comparable"].includes(row.direction)
    && (row.actual === null || text(row.actual.observationId) && isFiniteNumber(row.actual.value)
      && ["above", "below", "within"].includes(row.actual.outcome) && ["beat", "miss", "in_line", "neutral"].includes(row.actual.favorable)
      && isFiniteNumber(row.actual.difference) && isNullableFinite(row.actual.differencePct));
}
export function validateCompanyData<T extends CompanyDataset>(data: T): T {
  const coverage = data?.coverage;
  const common = !!data && text(data.symbol) && ["available", "unavailable"].includes(data.status)
    && isNullableIsoInstant(data.asOf) && ["full", "preview"].includes(data.access)
    && isNonNegativeInt(data.lockedRows) && isNonNegativeInt(data.totalRows) && typeof data.truncated === "boolean"
    && (data.previewRows === null || isNonNegativeInt(data.previewRows)) && text(data.methodology)
    && !!coverage && [coverage.documents, coverage.observations, coverage.guidance, coverage.conflicts].every(isNonNegativeInt)
    && isStringArray(coverage.languages) && Array.isArray(coverage.sourceKinds)
    && coverage.sourceKinds.every(isNonEmptyText) && Array.isArray(data.dictionary);
  const valid = common && ("series" in data
    ? Array.isArray(data.series) && data.series.every((series) => !!series && text(series.key) && validObservation(series.latest) && series.latest.seriesKey === series.key
      && Array.isArray(series.observations) && series.observations.every((row) => validObservation(row) && row.seriesKey === series.key))
      && Array.isArray(data.revisions) && data.revisions.every(validObservation)
    : Array.isArray(data.guidance) && data.guidance.every(validGuidance) && Array.isArray(data.history) && data.history.every(validGuidance));
  if (!valid) throw new Error("The server returned unreadable company disclosures");
  return data;
}
type CompanyClient = Pick<typeof apiClient, "getCloudCompanyKpis" | "getCloudCompanyGuidance">;
/** The server answers for the symbol it was asked about; for a listing abroad, its bare symbol or its venue key. */
function answersFor(answered: string, symbol: string, abroad: ListingAbroad | null): boolean {
  if (!abroad) return answered.toUpperCase() === symbol.trim().toUpperCase();
  const parsed = parsePublicTickerKey(answered);
  return parsed.symbol === abroad.symbol && (!parsed.exchange || parsed.exchange === abroad.exchange);
}
/** A listing abroad is its venue and company, so it never shares an entry with a US company of the same symbol. */
function companyIdentity(symbol: string, listing: IssuerListingParams): string {
  const abroad = listingAbroad(symbol, listing.exchange, listing.name);
  return abroad ? JSON.stringify([abroad.symbol, abroad.exchange, abroad.name ?? null]) : symbol.toUpperCase();
}
interface CompanyArgs { mode: CompanyMode; symbol: string; access?: string; options?: KpiQueryOptions; listing?: IssuerListingParams }
// Version 2: keys name a listing abroad by venue and company, not by the symbol alone.
// Partition paid history by both identity and entitlement, including screenshot snapshots.
const companyKpisEndpoint = createCloudEndpoint<CompanyArgs, CompanyDataset, CompanyClient>({
  kind: "company-kpis", schemaVersion: 2, policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
  key: ({ mode, symbol, access, listing = {} }) => `${mode}:${companyIdentity(symbol, listing)}:${access}`,
  defaultClient: apiClient,
  fetch: async ({ mode, symbol, options = {}, listing = {} }, client, signal) => {
    const request = signal ? { signal } : undefined;
    const data = validateCompanyData(await (mode === "kpis" ? client.getCloudCompanyKpis(symbol, options, listing, request) : client.getCloudCompanyGuidance(symbol, options, listing, request)));
    if (("series" in data) !== (mode === "kpis") || !answersFor(data.symbol, symbol, listingAbroad(symbol, listing.exchange, listing.name))) throw new Error("Company disclosures do not match the requested company");
    return data;
  },
  validate: validateCompanyData,
  unavailableMessage: KPI_UNAVAILABLE, unavailableStatuses: [404, 503],
});
export const companyKpisCache = companyKpisEndpoint.cache;
export const fetchCompanyData = (mode: CompanyMode, symbol: string, options: KpiQueryOptions = {}, client: CompanyClient = apiClient, listing: IssuerListingParams = {}, signal?: AbortSignal) =>
  companyKpisEndpoint.fetch({ mode, symbol, options, listing }, { client, signal });
export const companyQuery = (options: Record<string, unknown>): KpiQueryOptions => Object.fromEntries(["metric", "basis", "from", "to", "asOf"]
  .flatMap((key) => typeof options[key] === "string" && options[key] !== "all" ? [[key, options[key]]] : [])) as KpiQueryOptions;
export const cachedCompanyData = (mode: CompanyMode, symbol: string, access: string, listing: IssuerListingParams = {}) =>
  companyKpisEndpoint.cached({ mode, symbol, access, listing });
export const loadCompanyData = (mode: CompanyMode, symbol: string, access: string, force = false, listing: IssuerListingParams = {}) =>
  companyKpisEndpoint.load({ mode, symbol, access, listing }, { force });
