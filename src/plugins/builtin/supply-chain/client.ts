import { apiClient } from "../../../api-client";
import type { SupplyChainPayload, SupplyEntity, SupplyEvidenceItem, SupplyRead, SupplyRow } from "../../../api-client/supply-chain";
import { createPluginCache } from "../../../data/plugin-cache";
import { hasUniqueIds, isCalendarDay, isCurrencyCode, isFraction, isHttpUrl, isIsoInstant, isNonNegative, isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isNullableString, isPositiveNumber, isRecord } from "../../../utils/guards";
import { batchReplyItems, cachedCloudResource, createCloudBatchAhead, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { activeRelationship, canShowQuote, isUnconfirmed, publicEvidence, supplyOptions, TIER_OPTIONS, trustTier } from "./trust";

export const SUPPLY_UNAVAILABLE = "Supply chain disclosures are not available yet.";
const SUPPLY_ROLES = ["customer", "supplier", "partner", "competitor", "investee"] as const;
export const supplyChainCache = createPluginCache<SupplyChainPayload>({
  kind: "supply-chain", source: "gloom-cloud", schemaVersion: 3,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
});
const text = (value: unknown): value is string => typeof value === "string";
const nullableNumber = (value: unknown) => value === null || isNonNegative(value);
const optionalText = (value: unknown) => value === undefined || isNullableString(value);
/** A period length in months; absent from older servers. */
export const validPeriodMonths = (value: unknown) => value === undefined || value === null || isNonNegativeInt(value) && value <= 60;
const tier = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6;
const claim = (value: unknown) => ["disclosed", "company_confirmed", "reported", "rumored"].includes(String(value));
function evidence(value: SupplyEvidenceItem): boolean {
  return !!value && text(value.id) && tier(value.tier) && claim(value.claimType) && isHttpUrl(value.url)
    && text(value.title) && text(value.publisher) && isIsoInstant(value.publishedAt) && isIsoInstant(value.fetchedAt)
    && isNullableString(value.quote) && ["full", "short", "link_only"].includes(value.quoteRights)
    && ["publisher_text", "asr", "ocr", "snippet"].includes(value.textOrigin)
    && isNullableString(value.quoteLanguage) && isNullableString(value.englishGloss) && text(value.originKey)
    && isFraction(value.confidence) && ["active", "superseded", "rejected", "stale"].includes(value.status)
    && (value.verificationStatus === undefined || ["verified", "lead"].includes(value.verificationStatus))
    && isNullableString(value.valueKind) && isNullableFinite(value.value) && isNullableString(value.valueUnit) && isNullableString(value.currency)
    && (value.relatedParty === undefined || typeof value.relatedParty === "boolean");
}
export function validSupplyEntity(value: SupplyEntity): boolean {
  return !!value && text(value.id) && text(value.name) && isNullableString(value.ticker) && isNullableString(value.exchange)
    && isNullableString(value.country) && ["listed", "private", "government", "unknown"].includes(value.kind)
    && isRecord(value.identifiers) && typeof value.anonymous === "boolean" && (!value.anonymous || value.ticker === null)
    && (value.aggregate === undefined || typeof value.aggregate === "boolean");
}
export function validSupplyRow(value: SupplyRow): boolean {
  return !!value && text(value.id) && validSupplyEntity(value.counterparty) && validSupplyEntity(value.reportingEntity)
    && SUPPLY_ROLES.includes(value.role) && ["in", "out", "mutual"].includes(value.direction)
    && isNullableString(value.pctScope) && [undefined, null, "total", "segment"].includes(value.pctScopeBasis)
    && nullableNumber(value.pctOfRevenue) && (value.pctOfRevenue === null || value.pctOfRevenue <= 100)
    && [null, "revenue", "receivables", "cost", "purchases"].includes(value.pctBasis)
    && nullableNumber(value.usd) && [null, "disclosed", "derived"].includes(value.usdBasis)
    && (value.nativeAmount == null || isNonNegative(value.nativeAmount))
    && (value.nativeCurrency == null || isCurrencyCode(value.nativeCurrency))
    && (value.nativeScale == null || isPositiveNumber(value.nativeScale))
    && (value.nativeAmount == null || (value.nativeCurrency != null && value.nativeScale != null && Number.isFinite(value.nativeAmount * value.nativeScale)))
    && (value.jurisdiction == null || (text(value.jurisdiction) && /^[A-Z]{2}$/.test(value.jurisdiction)))
    && [undefined, null, "entity", "group", "anonymous", "aggregate"].includes(value.entityScope)
    && (value.relatedParty === undefined || typeof value.relatedParty === "boolean")
    && (value.pctOfRevenue === null || value.pctBasis !== null) && (value.usd === null || value.usdBasis !== null)
    && text(value.period) && validPeriodMonths(value.periodMonths) && isNullableString(value.fiscalYear) && ["xbrl", "filing_text", "call", "news", "web", "import", "press_release"].includes(value.sourceKind)
    && isNullableString(value.form) && isNullableCalendarDay(value.filedDate) && isCalendarDay(value.asOf) && isFraction(value.confidence)
    && text(value.quote) && (value.quote.trim().length > 0 || !!value.evidence?.length) && isNullableString(value.quoteLanguage)
    && optionalText(value.quoteGloss) && optionalText(value.sectionRef) && optionalText(value.sourceAttribution)
    && [null, "exact", "whitespace", "nfkc_whitespace"].includes(value.quoteMatchMode)
    && isHttpUrl(value.filingUrl) && isNullableString(value.accession)
    && (value.tier === undefined || tier(value.tier)) && (value.claimType === undefined || claim(value.claimType))
    && (value.corroboration === undefined || isNonNegativeInt(value.corroboration))
    && (value.leadStatus === undefined || ["none", "lead", "verified", "rejected", "stale"].includes(value.leadStatus))
    && [value.firstSeenAt, value.lastSeenAt, value.lastConfirmedAt].every((value) => value === undefined || value === null || isIsoInstant(value))
    && (value.whyUnconfirmed === undefined || isNullableString(value.whyUnconfirmed))
    && (value.evidence === undefined || Array.isArray(value.evidence) && value.evidence.every(evidence));
}
export function normalizeSupplyRow(input: SupplyRow): SupplyRow {
  // A share basis a server sends as null is no basis read yet, as an absent one is.
  const { pctScopeBasis, ...rest } = input;
  const value: SupplyRow = pctScopeBasis == null ? rest : input;
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
const validRoleGroup = (group: Record<"says" | "names", SupplyRow[]>, counts: SupplyChainPayload["counts"] | undefined) =>
  (["says", "names"] as const).every((key) => {
    const rows = group[key];
    return Array.isArray(rows) && rows.every(validSupplyRow) && hasUniqueIds(rows)
      && SUPPLY_ROLES.every((role) => Number.isInteger(counts?.[key]?.[role]) && counts![key][role] >= rows.filter((entry) => entry.role === role).length);
  });
const afterCutoff = (value: string | null | undefined, cutoff: string) => !!value && value > cutoff;
const afterCutoffInstant = (value: string | null | undefined, cutoff: string) => !!value && new Date(value).toISOString().slice(0, 10) > cutoff;

export function laterSupplyEvidence(row: SupplyRow, cutoff: string): boolean {
  // Fetch and first/last seen times record ingestion, not when the evidence became public.
  return afterCutoff(row.asOf, cutoff) || afterCutoff(row.filedDate, cutoff)
    || (isCalendarDay(row.period) && afterCutoff(row.period, cutoff))
    || afterCutoffInstant(row.lastConfirmedAt, cutoff)
    || !!row.evidence?.some(item => afterCutoffInstant(item.publishedAt, cutoff));
}

export function validateSupplyChain(data: SupplyChainPayload, cutoff?: string): SupplyChainPayload {
  const valid = !!data && text(data.symbol) && (data.entity === null || validSupplyEntity(data.entity))
    && (data.directories === undefined || Array.isArray(data.directories) && data.directories.every(report =>
      !!report && text(report.buyer) && text(report.buyerListing) && typeof report.buyerView === "boolean"
      && isHttpUrl(report.url) && isHttpUrl(report.page) && isNullableCalendarDay(report.effectiveDay)
      && isIsoInstant(report.observedAt) && /^[a-f0-9]{64}$/.test(report.sha256) && Number.isInteger(report.total)
      && Array.isArray(report.entries) && report.entries.length <= report.total
      && (data.access === "full" ? report.entries.length === report.total : report.entries.length <= 3)
      && report.entries.every(row => !!row && text(row.operator) && text(row.kind)
        && [row.country, row.city, row.parent, row.operatorListing, row.parentListing].every(isNullableString))))
    && isNullableCalendarDay(data.asOf) && ["available", "unavailable"].includes(data.status)
    && validRoleGroup(data, data.counts) && (data.earlier === undefined || validRoleGroup(data.earlier, data.earlierCounts))
    && Number.isInteger(data.totalRows) && data.totalRows >= data.says.length + data.names.length
    && ["full", "preview"].includes(data.access) && isNonNegativeInt(data.lockedRows)
    && typeof data.truncated === "boolean" && [3, null].includes(data.previewRowsPerRole)
    && text(data.disclaimer) && (data.tierCounts === undefined || TIER_OPTIONS.every(({ value }) => isNonNegativeInt(data.tierCounts?.[value])));
  if (!valid) throw new Error("The server returned unreadable supply chain disclosures");
  if (cutoff && (afterCutoff(data.asOf, cutoff)
    || [...data.says, ...data.names, ...data.earlier?.says ?? [], ...data.earlier?.names ?? []].some(row => laterSupplyEvidence(row, cutoff))
    || data.directories?.some(report => afterCutoff(report.effectiveDay, cutoff) || afterCutoffInstant(report.observedAt, cutoff)))) {
    throw new Error(`Supply chain returned disclosures published after ${cutoff}; none are shown.`);
  }
  const normalizeEntity = (value: SupplyEntity): SupplyEntity => ({ ...value, aggregate: value.aggregate ?? false });
  return { ...data, entity: data.entity ? normalizeEntity(data.entity) : null, says: data.says.map(normalizeSupplyRow), names: data.names.map(normalizeSupplyRow),
    ...(data.earlier ? { earlier: { says: data.earlier.says.map(normalizeSupplyRow), names: data.earlier.names.map(normalizeSupplyRow) } } : {}) };
}
export async function fetchSupplyChain(symbol: string, client: Pick<typeof apiClient, "getCloudSupplyChain"> = apiClient, options: SupplyRead = {}) {
  let data: SupplyChainPayload;
  try { data = await client.getCloudSupplyChain(symbol, options); }
  catch (error) { throw unavailableOnServer(error, SUPPLY_UNAVAILABLE, [404, 503]); }
  return validateSupplyChain(data, options.asOf);
}
// Account and plan belong in the key: signing out must never reveal a paid cached response.
const cacheKey = (symbol: string, access: string, options: SupplyRead) => `${symbol.toUpperCase()}:${access}:${JSON.stringify(supplyOptions(options.tiers))}:${!!options.includeLeads}${options.asOf ? `:${options.asOf}` : ""}`;
export const cachedSupplyChain = (symbol: string, access: string, options: SupplyRead = {}) => cachedCloudResource(supplyChainCache, cacheKey(symbol, access, options), data => validateSupplyChain(data, options.asOf));
export const loadSupplyChain = (symbol: string, access: string, force = false, options: SupplyRead = {}) => loadCloudResource(supplyChainCache, cacheKey(symbol, access, options), () => fetchSupplyChain(symbol, apiClient, options), { force, validate: data => validateSupplyChain(data, options.asOf) });
/** Symbols per disclosures batch request: a ripple's sixty holdings are two, read sixteen at a time on the server. */
const SUPPLY_BATCH_MAX = 30;
const supplyChainsAheadByOptions = new Map<string, ReturnType<typeof createCloudBatchAhead<SupplyChainPayload>>>();
/**
 * Reads many symbols' disclosures ahead in a request per 30 (EARN ripple's
 * holdings), into the cache loadSupplyChain reads. Answers the symbols stored.
 */
export function loadSupplyChainsAhead(symbols: readonly string[], access: string, force = false, options: SupplyRead = {}): Promise<Set<string>> {
  if (options.asOf) return Promise.resolve(new Set());
  const optionsKey = JSON.stringify([supplyOptions(options.tiers), !!options.includeLeads]);
  let ahead = supplyChainsAheadByOptions.get(optionsKey);
  if (!ahead) {
    ahead = createCloudBatchAhead(supplyChainCache, {
      max: SUPPLY_BATCH_MAX,
      validate: validateSupplyChain,
      read: async (ids) => batchReplyItems(await apiClient.getCloudSupplyChains(ids, options))
        .flatMap((item) => item.chain ? [{ id: item.symbol.toUpperCase(), payload: item.chain }] : []),
    });
    supplyChainsAheadByOptions.set(optionsKey, ahead);
  }
  return ahead(symbols.map((symbol) => ({ id: symbol.toUpperCase(), key: cacheKey(symbol, access, options) })), force);
}
