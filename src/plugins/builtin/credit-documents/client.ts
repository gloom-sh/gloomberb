import { isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { apiClient } from "../../../api-client";
import type { CreditDocumentsPayload, CreditFact, CreditInstrument, CreditScreenPayload, CreditScreenQuery } from "../../../api-client/credit-documents";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

/** SEC issuer symbols omit US listing qualifiers; foreign venue identity stays intact. */
export const creditIssuerSymbol = (symbol: string) => {
  const parsed = parsePublicTickerKey(symbol.trim().toUpperCase());
  return parsed.exchange && isUsListingExchange(parsed.exchange) ? parsed.symbol : symbol.trim().toUpperCase();
};
export const CREDIT_UNAVAILABLE = "Credit documents are not available for this issuer yet.";
export const creditCache = createPluginCache<CreditDocumentsPayload>({
  kind: "credit-documents", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 7 * 86_400_000 },
});
const text = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const amount = (value: unknown) => value === null || (finite(value) && value >= 0);
const currency = (value: unknown) => value === null || (text(value) && /^[A-Z]{3}$/.test(value));
const day = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nullableDay = (value: unknown) => value === null || day(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const url = (value: unknown) => { try { return text(value) && ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } };
const unique = (rows: readonly { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
function fact(row: CreditFact): boolean {
  return !!row && [row.id, row.instrumentId, row.documentId, row.field, row.instrumentName, row.factKey, row.form, row.language].every(text)
    && row.value !== undefined && day(row.asOf) && day(row.filedAt) && nullableDay(row.periodEnd)
    && currency(row.currency) && (row.unit === null || text(row.unit))
    && finite(row.confidence) && row.confidence >= 0 && row.confidence <= 1
    && text(row.quote) && row.quote.trim().length > 0 && url(row.filingUrl)
    && Number.isInteger(row.quoteOffset) && row.quoteOffset >= 0 && Number.isInteger(row.quoteSourceLength) && row.quoteSourceLength > 0
    && ["exact", "whitespace", "nfkc_whitespace"].includes(row.quoteMatchMode)
    && ["active", "superseded"].includes(row.status) && (row.supersedesId === null || text(row.supersedesId));
}
export function validateCreditInstrument(row: CreditInstrument): CreditInstrument {
  if (!row || ![row.id, row.key, row.name].every(text) || !currency(row.currency)
    || (row.lifecycle !== undefined && row.lifecycle !== null && !text(row.lifecycle))
    || (row.facilityType !== null && !text(row.facilityType)) || ![row.principal, row.commitment, row.drawn].every(amount)
    || !nullableDay(row.maturity) || !Array.isArray(row.facts) || !row.facts.every(fact) || !unique(row.facts)
    || row.facts.some((entry) => entry.instrumentId !== row.id || entry.status !== "active")
    || (row.history !== undefined && (!Array.isArray(row.history) || !row.history.every(fact) || !unique(row.history) || row.history.some((entry) => entry.instrumentId !== row.id)))) {
    throw new Error("The server returned unreadable credit instrument evidence");
  }
  return row;
}
export function validateCreditDocuments(data: CreditDocumentsPayload, symbol?: string): CreditDocumentsPayload {
  const invalid = (): never => { throw new Error("The server returned unreadable credit documents"); };
  if (!data || data.version !== 1 || !text(data.symbol) || (symbol && data.symbol !== symbol)
    || !["available", "partial", "unavailable"].includes(data.status) || !nullableDay(data.asOf)
    || !["full", "preview"].includes(data.access) || !Number.isInteger(data.lockedRows) || data.lockedRows < 0
    || !(data.issuer === null || (data.issuer && [data.issuer.id, data.issuer.name, data.issuer.jurisdiction].every(text)))
    || !strings(data.warnings) || !Array.isArray(data.instruments) || !unique(data.instruments)
    || !Array.isArray(data.covenants) || !Array.isArray(data.maturities) || !Array.isArray(data.changeOfControl)) return invalid();
  data.instruments.forEach(validateCreditInstrument);
  const factIds = new Set(data.instruments.flatMap((row) => row.facts.map((entry) => entry.id)));
  const supported = (ids: unknown) => strings(ids) && ids.length > 0 && ids.every((id) => factIds.has(id));
  for (const row of data.covenants) {
    if (!row || ![row.id, row.instrumentId, row.instrumentName, row.metric].every(text) || !finite(row.threshold)
      || !["maximum", "minimum"].includes(row.comparator) || (row.inclusive !== undefined && typeof row.inclusive !== "boolean") || ![row.current, row.headroomPercent].every(nullableNumber)
      || !nullableDay(row.testDate) || !day(row.asOf) || !["compliant", "breach", "uncomputable", "stale", "conditional"].includes(row.status)
      || (row.reason !== null && !text(row.reason)) || !supported(row.evidenceIds)
      || (["uncomputable", "stale", "conditional"].includes(row.status) && row.headroomPercent !== null)) return invalid();
  }
  for (const row of data.maturities) if (!row || !Number.isInteger(row.year) || row.year < 1900 || row.year > 2300
    || !currency(row.currency) || row.currency === null || !finite(row.principal) || row.principal < 0
    || !Array.isArray(row.instruments) || row.instruments.some((entry) => !entry || !text(entry.id) || !text(entry.name) || !finite(entry.principal) || entry.principal < 0 || !supported(entry.evidenceIds))) return invalid();
  for (const row of data.changeOfControl) if (!row || !text(row.instrumentId) || !text(row.instrumentName) || !currency(row.currency)
    || !amount(row.principal) || !text(row.trigger) || !amount(row.putPercent) || !supported(row.evidenceIds)) return invalid();
  return data;
}
export function validateCreditScreen(data: CreditScreenPayload): CreditScreenPayload {
  if (!data || !["full", "preview"].includes(data.access) || !Number.isInteger(data.lockedRows) || data.lockedRows < 0
    || !text(data.asOf) || !Number.isFinite(Date.parse(data.asOf)) || typeof data.truncated !== "boolean" || !Array.isArray(data.rows) || data.rows.some((row) => !row
      || ![row.symbol, row.issuerName, row.instrumentId, row.instrumentName, row.reason].every(text)
      || !["headroom", "springing_maturity"].includes(row.kind) || !nullableNumber(row.value) || !nullableDay(row.date) || !currency(row.currency)
      || !Array.isArray(row.evidence) || !row.evidence.length || !row.evidence.every(fact))) throw new Error("The server returned unreadable credit screening results");
  return data;
}
export async function fetchCreditDocuments(symbol: string, client: Pick<typeof apiClient, "creditDocuments"> = apiClient) {
  try { const issuer = creditIssuerSymbol(symbol); return validateCreditDocuments(await client.creditDocuments<CreditDocumentsPayload>(encodeURIComponent(issuer)), issuer); }
  catch (error) { throw unavailableOnServer(error, CREDIT_UNAVAILABLE, [404, 503]); }
}
export async function fetchCreditInstrument(symbol: string, id: string, client: Pick<typeof apiClient, "creditDocuments"> = apiClient) {
  const data = validateCreditInstrument(await client.creditDocuments<CreditInstrument>(`${encodeURIComponent(creditIssuerSymbol(symbol))}/instruments/${encodeURIComponent(id)}`));
  if (data.id !== id) throw new Error("The server returned evidence for a different credit instrument");
  return data;
}
export async function fetchCreditScreen(query: CreditScreenQuery = {}, client: Pick<typeof apiClient, "creditDocuments"> = apiClient) {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(query)) if (value !== undefined) params.set(key,String(value));
  return validateCreditScreen(await client.creditDocuments<CreditScreenPayload>(`screen?${params}`));
}
// Private credit evidence must never survive an account or entitlement change.
const key = (symbol: string, access: string) => `${symbol.toUpperCase()}:${access}`;
export const cachedCredit = (symbol: string, access: string) => cachedCloudResource(creditCache, key(symbol, access), (data) => validateCreditDocuments(data, creditIssuerSymbol(symbol)));
export const loadCredit = (symbol: string, access: string, force = false) => loadCloudResource(creditCache, key(symbol, access), () => fetchCreditDocuments(symbol), { force, validate: (data) => validateCreditDocuments(data, creditIssuerSymbol(symbol)) });
