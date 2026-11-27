import { isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { apiClient } from "../../../api-client";
import type { CreditDocumentsPayload, CreditFact, CreditInstrument, CreditScreenPayload, CreditScreenQuery } from "../../../api-client/credit-documents";
import { hasUniqueIds, isCalendarDay, isCurrencyCode, isFiniteNumber, isFraction, isHttpUrl, isNonEmptyText, isNonNegative, isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

/** SEC issuer symbols omit US listing qualifiers; foreign venue identity stays intact. */
export const creditIssuerSymbol = (symbol: string) => {
  const parsed = parsePublicTickerKey(symbol.trim().toUpperCase());
  return parsed.exchange && isUsListingExchange(parsed.exchange) ? parsed.symbol : symbol.trim().toUpperCase();
};
export const CREDIT_UNAVAILABLE = "Credit documents are not available for this issuer yet.";
const text = (value: unknown): value is string => typeof value === "string";
const amount = (value: unknown) => value === null || isNonNegative(value);
const currency = (value: unknown) => value === null || isCurrencyCode(value);
function fact(row: CreditFact): boolean {
  return !!row && [row.id, row.instrumentId, row.documentId, row.field, row.instrumentName, row.factKey, row.form, row.language].every(text)
    && row.value !== undefined && isCalendarDay(row.asOf) && isCalendarDay(row.filedAt) && isNullableCalendarDay(row.periodEnd)
    && (row.effectiveDate === undefined || isNullableCalendarDay(row.effectiveDate))
    && currency(row.currency) && (row.unit === null || text(row.unit))
    && isFraction(row.confidence) && isNonEmptyText(row.quote) && isHttpUrl(row.filingUrl)
    && isNonNegativeInt(row.quoteOffset) && Number.isInteger(row.quoteSourceLength) && row.quoteSourceLength > 0
    && ["exact", "whitespace", "nfkc_whitespace"].includes(row.quoteMatchMode)
    && ["active", "superseded", "pending"].includes(row.status) && (row.supersedesId === null || text(row.supersedesId));
}
export function validateCreditInstrument(row: CreditInstrument): CreditInstrument {
  if (!row || ![row.id, row.key, row.name].every(text) || !currency(row.currency)
    || (row.lifecycle !== undefined && row.lifecycle !== null && !text(row.lifecycle))
    || (row.facilityType !== null && !text(row.facilityType)) || ![row.principal, row.commitment, row.drawn].every(amount)
    || !isNullableCalendarDay(row.maturity) || !Array.isArray(row.facts) || !row.facts.every(fact) || !hasUniqueIds(row.facts)
    || row.facts.some((entry) => entry.instrumentId !== row.id || entry.status !== "active")
    || (row.history !== undefined && (!Array.isArray(row.history) || !row.history.every(fact) || !hasUniqueIds(row.history) || row.history.some((entry) => entry.instrumentId !== row.id)))) {
    throw new Error("The server returned unreadable credit instrument evidence");
  }
  return row;
}
export function validateCreditDocuments(data: CreditDocumentsPayload, symbol?: string): CreditDocumentsPayload {
  const invalid = (): never => { throw new Error("The server returned unreadable credit documents"); };
  if (!data || data.version !== 1 || !text(data.symbol) || (symbol && data.symbol !== symbol)
    || !["available", "partial", "unavailable"].includes(data.status) || !isNullableCalendarDay(data.asOf)
    || !["full", "preview"].includes(data.access) || !isNonNegativeInt(data.lockedRows)
    || !(data.issuer === null || (data.issuer && [data.issuer.id, data.issuer.name, data.issuer.jurisdiction].every(text)))
    || !isStringArray(data.warnings) || !Array.isArray(data.instruments) || !hasUniqueIds(data.instruments)
    || !Array.isArray(data.covenants) || !Array.isArray(data.maturities) || !Array.isArray(data.changeOfControl)) return invalid();
  data.instruments.forEach(validateCreditInstrument);
  const factOwners = new Map(data.instruments.flatMap((row) => row.facts.map((entry) => [entry.id, row.id] as const)));
  const supported = (ids: unknown, instrumentId: string) => isStringArray(ids) && ids.length > 0 && ids.every((id) => factOwners.get(id) === instrumentId);
  for (const row of data.covenants) {
    if (!row || ![row.id, row.instrumentId, row.instrumentName, row.metric].every(text) || !isFiniteNumber(row.threshold)
      || !["maximum", "minimum"].includes(row.comparator) || (row.inclusive !== undefined && typeof row.inclusive !== "boolean") || ![row.current, row.headroomPercent].every(isNullableFinite)
      || !isNullableCalendarDay(row.testDate) || !isCalendarDay(row.asOf) || !["compliant", "breach", "uncomputable", "stale", "conditional"].includes(row.status)
      || (row.reason !== null && !text(row.reason)) || !supported(row.evidenceIds, row.instrumentId)
      || (["uncomputable", "stale", "conditional"].includes(row.status) && row.headroomPercent !== null)) return invalid();
  }
  for (const row of data.maturities) if (!row || !Number.isInteger(row.year) || row.year < 1900 || row.year > 2300
    || !isCurrencyCode(row.currency) || !isNonNegative(row.principal)
    || !Array.isArray(row.instruments) || row.instruments.some((entry) => !entry || !text(entry.id) || !text(entry.name) || !isNonNegative(entry.principal) || !supported(entry.evidenceIds, entry.id))) return invalid();
  for (const row of data.changeOfControl) if (!row || !text(row.instrumentId) || !text(row.instrumentName) || !currency(row.currency)
    || !amount(row.principal) || !text(row.trigger) || !amount(row.putPercent) || !supported(row.evidenceIds, row.instrumentId)) return invalid();
  return data;
}
export function validateCreditScreen(data: CreditScreenPayload): CreditScreenPayload {
  if (!data || !["full", "preview"].includes(data.access) || !isNonNegativeInt(data.lockedRows)
    || !text(data.asOf) || !Number.isFinite(Date.parse(data.asOf)) || typeof data.truncated !== "boolean" || !Array.isArray(data.rows) || data.rows.some((row) => !row
      || ![row.symbol, row.issuerName, row.instrumentId, row.instrumentName, row.reason].every(text)
      || !["headroom", "springing_maturity"].includes(row.kind) || !isNullableFinite(row.value) || !isNullableCalendarDay(row.date) || !currency(row.currency)
      || !Array.isArray(row.evidence) || !row.evidence.length || !row.evidence.every((entry) => fact(entry) && entry.status === "active" && entry.instrumentId === row.instrumentId))) throw new Error("The server returned unreadable credit screening results");
  return data;
}
// Private credit evidence must never survive an account or entitlement change.
const creditEndpoint = createCloudEndpoint<{ symbol: string; access?: string }, CreditDocumentsPayload, Pick<typeof apiClient, "creditDocuments">>({
  kind: "credit-documents", schemaVersion: 1, policy: { staleMs: 60 * 60_000, expireMs: 7 * 86_400_000 },
  key: ({ symbol, access }) => `${symbol.toUpperCase()}:${access}`, defaultClient: apiClient,
  fetch: ({ symbol }, client) => client.creditDocuments<CreditDocumentsPayload>(encodeURIComponent(creditIssuerSymbol(symbol))),
  validate: (data, { symbol }) => validateCreditDocuments(data, creditIssuerSymbol(symbol)),
  unavailableMessage: CREDIT_UNAVAILABLE, unavailableStatuses: [404, 503],
});
export const creditCache = creditEndpoint.cache;
export const fetchCreditDocuments = (symbol: string, client: Pick<typeof apiClient, "creditDocuments"> = apiClient) =>
  creditEndpoint.fetch({ symbol }, { client });
export async function fetchCreditInstrument(symbol: string, id: string, client: Pick<typeof apiClient, "creditDocuments"> = apiClient) {
  const data = validateCreditInstrument(await client.creditDocuments<CreditInstrument>(`${encodeURIComponent(creditIssuerSymbol(symbol))}/instruments/${encodeURIComponent(id)}`));
  if (data.id !== id) throw new Error("The server returned evidence for a different credit instrument");
  return data;
}
export async function fetchCreditScreen(query: CreditScreenQuery = {}, client: Pick<typeof apiClient, "creditDocuments"> = apiClient) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return validateCreditScreen(await client.creditDocuments<CreditScreenPayload>(`screen?${params}`));
}
export const cachedCredit = (symbol: string, access: string) => creditEndpoint.cached({ symbol, access });
export const loadCredit = (symbol: string, access: string, force = false) => creditEndpoint.load({ symbol, access }, { force });
