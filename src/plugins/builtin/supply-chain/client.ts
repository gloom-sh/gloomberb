import { apiClient } from "../../../api-client";
import type { SupplyChainPayload, SupplyEntity, SupplyEvidenceItem, SupplyOptions, SupplyRow } from "../../../api-client/supply-chain";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { activeRelationship, canShowQuote, isUnconfirmed, publicEvidence, supplyOptions, TIER_OPTIONS, trustTier } from "./trust";

export const SUPPLY_UNAVAILABLE = "Supply chain disclosures are not available yet.";
const SUPPLY_ROLES = ["customer", "supplier", "partner", "competitor", "investee"] as const;
export const supplyChainCache = createPluginCache<SupplyChainPayload>({
  kind: "supply-chain", source: "gloom-cloud", schemaVersion: 2,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
});
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown) => finite(value) && value >= 0;
const nullableNumber = (value: unknown) => value === null || nonnegative(value);
const optionalText = (value: unknown) => value === undefined || nullableText(value);
const date = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const tier = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6;
const claim = (value: unknown) => ["disclosed", "company_confirmed", "reported", "rumored"].includes(String(value));
const url = (value: unknown) => { try { return text(value) && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
function evidence(value: SupplyEvidenceItem): boolean {
  return !!value && text(value.id) && tier(value.tier) && claim(value.claimType) && url(value.url)
    && text(value.title) && text(value.publisher) && timestamp(value.publishedAt) && timestamp(value.fetchedAt)
    && nullableText(value.quote) && ["full", "short", "link_only"].includes(value.quoteRights)
    && ["publisher_text", "asr", "ocr", "snippet"].includes(value.textOrigin)
    && nullableText(value.quoteLanguage) && nullableText(value.englishGloss) && text(value.originKey)
    && finite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && ["active", "superseded", "rejected", "stale"].includes(value.status)
    && (value.verificationStatus === undefined || ["verified", "lead"].includes(value.verificationStatus))
    && nullableText(value.valueKind) && (value.value === null || finite(value.value)) && nullableText(value.valueUnit) && nullableText(value.currency);
}
export function validSupplyEntity(value: SupplyEntity): boolean {
  return !!value && text(value.id) && text(value.name) && nullableText(value.ticker) && nullableText(value.exchange)
    && nullableText(value.country) && ["listed", "private", "government", "unknown"].includes(value.kind)
    && !!value.identifiers && typeof value.identifiers === "object" && !Array.isArray(value.identifiers)
    && typeof value.anonymous === "boolean" && (!value.anonymous || value.ticker === null)
    && (value.aggregate === undefined || typeof value.aggregate === "boolean");
}
export function validSupplyRow(value: SupplyRow): boolean {
  return !!value && text(value.id) && validSupplyEntity(value.counterparty) && validSupplyEntity(value.reportingEntity)
    && SUPPLY_ROLES.includes(value.role) && ["in", "out", "mutual"].includes(value.direction)
    && nullableText(value.pctScope) && nullableNumber(value.pctOfRevenue) && (value.pctOfRevenue === null || value.pctOfRevenue <= 100)
    && [null, "revenue", "receivables", "cost", "purchases"].includes(value.pctBasis)
    && nullableNumber(value.usd) && [null, "disclosed", "derived"].includes(value.usdBasis)
    && (value.nativeAmount == null || nonnegative(value.nativeAmount))
    && (value.nativeCurrency == null || (text(value.nativeCurrency) && /^[A-Z]{3}$/.test(value.nativeCurrency)))
    && (value.nativeScale == null || (finite(value.nativeScale) && value.nativeScale > 0))
    && (value.nativeAmount == null || (value.nativeCurrency != null && value.nativeScale != null && Number.isFinite(value.nativeAmount * value.nativeScale)))
    && (value.jurisdiction == null || (text(value.jurisdiction) && /^[A-Z]{2}$/.test(value.jurisdiction)))
    && [undefined, null, "entity", "group", "anonymous", "aggregate"].includes(value.entityScope)
    && (value.pctOfRevenue === null || value.pctBasis !== null) && (value.usd === null || value.usdBasis !== null)
    && text(value.period) && nullableText(value.fiscalYear) && ["xbrl", "filing_text", "call", "news", "web", "import", "press_release"].includes(value.sourceKind)
    && nullableText(value.form) && (value.filedDate === null || date(value.filedDate)) && date(value.asOf)
    && finite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && text(value.quote) && (value.quote.trim().length > 0 || !!value.evidence?.length) && nullableText(value.quoteLanguage)
    && optionalText(value.quoteGloss) && optionalText(value.sectionRef) && optionalText(value.sourceAttribution)
    && [null, "exact", "whitespace", "nfkc_whitespace"].includes(value.quoteMatchMode)
    && url(value.filingUrl) && nullableText(value.accession)
    && (value.tier === undefined || tier(value.tier)) && (value.claimType === undefined || claim(value.claimType))
    && (value.corroboration === undefined || Number.isInteger(value.corroboration) && value.corroboration >= 0)
    && (value.leadStatus === undefined || ["none", "lead", "verified", "rejected", "stale"].includes(value.leadStatus))
    && [value.firstSeenAt, value.lastSeenAt, value.lastConfirmedAt].every((value) => value === undefined || value === null || timestamp(value))
    && (value.whyUnconfirmed === undefined || nullableText(value.whyUnconfirmed))
    && (value.evidence === undefined || Array.isArray(value.evidence) && value.evidence.every(evidence));
}
export function normalizeSupplyRow(value: SupplyRow): SupplyRow {
  const items = value.evidence?.map(publicEvidence);
  const unconfirmed = isUnconfirmed(value) || !activeRelationship(value);
  // Restrict again before cache, exports or screenshot metadata, even if a server regresses.
  const selected = items?.find((item) => item.status === "active" && item.tier === trustTier(value)) ?? items?.find((item) => item.status === "active");
  return { ...value, counterparty: { ...value.counterparty, aggregate: value.counterparty.aggregate ?? false }, reportingEntity: { ...value.reportingEntity, aggregate: value.reportingEntity.aggregate ?? false },
    ...(trustTier(value) !== 1 || unconfirmed ? { pctOfRevenue: null, pctBasis: null, pctScope: null } : {}),
    ...(unconfirmed ? { usd: null, usdBasis: null, nativeAmount: null, nativeCurrency: null, nativeScale: null, lastConfirmedAt: null } : {}),
    ...(items?.length ? { evidence: items, quote: selected && canShowQuote(selected) ? selected.quote ?? "" : "",
      quoteLanguage: selected?.quoteLanguage ?? null, quoteGloss: selected && canShowQuote(selected) ? selected.englishGloss : null } : {}) };
}
export function validateSupplyChain(data: SupplyChainPayload): SupplyChainPayload {
  const valid = !!data && text(data.symbol) && (data.entity === null || validSupplyEntity(data.entity))
    && (data.asOf === null || date(data.asOf)) && ["available", "unavailable"].includes(data.status)
    && ["says", "names"].every((view) => {
      const key = view as "says" | "names";
      const rows = data[key];
      return Array.isArray(rows) && rows.every(validSupplyRow) && new Set(rows.map((entry) => entry.id)).size === rows.length
        && SUPPLY_ROLES.every((role) => Number.isInteger(data.counts?.[key]?.[role])
          && data.counts[key][role] >= rows.filter((entry) => entry.role === role).length);
    }) && Number.isInteger(data.totalRows) && data.totalRows >= data.says.length + data.names.length
    && ["full", "preview"].includes(data.access) && Number.isInteger(data.lockedRows) && data.lockedRows >= 0
    && typeof data.truncated === "boolean" && [3, null].includes(data.previewRowsPerRole)
    && text(data.disclaimer) && (data.tierCounts === undefined || TIER_OPTIONS.every(({ value }) => Number.isInteger(data.tierCounts?.[value]) && data.tierCounts![value] >= 0));
  if (!valid) throw new Error("The server returned unreadable supply chain disclosures");
  const normalizeEntity = (value: SupplyEntity): SupplyEntity => ({ ...value, aggregate: value.aggregate ?? false });
  return { ...data, entity: data.entity ? normalizeEntity(data.entity) : null, says: data.says.map(normalizeSupplyRow), names: data.names.map(normalizeSupplyRow) };
}
export async function fetchSupplyChain(symbol: string, client: Pick<typeof apiClient, "getCloudSupplyChain"> = apiClient, options: SupplyOptions = {}) {
  try { return validateSupplyChain(await client.getCloudSupplyChain(symbol, options)); }
  catch (error) { throw unavailableOnServer(error, SUPPLY_UNAVAILABLE, [404, 503]); }
}
// Account and plan belong in the key: signing out must never reveal a paid cached response.
const cacheKey = (symbol: string, access: string, options: SupplyOptions) => `${symbol.toUpperCase()}:${access}:${JSON.stringify(supplyOptions(options.tiers))}:${!!options.includeLeads}`;
export const cachedSupplyChain = (symbol: string, access: string, options: SupplyOptions = {}) => cachedCloudResource(supplyChainCache, cacheKey(symbol, access, options), validateSupplyChain);
export const loadSupplyChain = (symbol: string, access: string, force = false, options: SupplyOptions = {}) => loadCloudResource(supplyChainCache, cacheKey(symbol, access, options), () => fetchSupplyChain(symbol, apiClient, options), { force, validate: validateSupplyChain });
