import { apiClient } from "../../../api-client";
import type { SupplyChainPayload, SupplyEntity, SupplyRow } from "../../../api-client/supply-chain";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export const SUPPLY_UNAVAILABLE = "Supply chain disclosures are not available yet.";
const SUPPLY_ROLES = ["customer", "supplier", "partner", "competitor", "investee"] as const;
export const supplyChainCache = createPluginCache<SupplyChainPayload>({
  kind: "supply-chain", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
});
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown) => finite(value) && value >= 0;
const nullableNumber = (value: unknown) => value === null || nonnegative(value);
const date = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const url = (value: unknown) => { try { return text(value) && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
function entity(value: SupplyEntity): boolean {
  return !!value && text(value.id) && text(value.name) && nullableText(value.ticker) && nullableText(value.exchange)
    && nullableText(value.country) && ["listed", "private", "government", "unknown"].includes(value.kind)
    && !!value.identifiers && typeof value.identifiers === "object" && !Array.isArray(value.identifiers)
    && typeof value.anonymous === "boolean" && (!value.anonymous || value.ticker === null);
}
function row(value: SupplyRow): boolean {
  return !!value && text(value.id) && entity(value.counterparty) && entity(value.reportingEntity)
    && SUPPLY_ROLES.includes(value.role) && ["in", "out", "mutual"].includes(value.direction)
    && nullableText(value.pctScope) && nullableNumber(value.pctOfRevenue) && (value.pctOfRevenue === null || value.pctOfRevenue <= 100)
    && [null, "revenue", "receivables", "cost", "purchases"].includes(value.pctBasis)
    && nullableNumber(value.usd) && [null, "disclosed", "derived"].includes(value.usdBasis)
    && (value.pctOfRevenue === null || value.pctBasis !== null) && (value.usd === null || value.usdBasis !== null)
    && text(value.period) && nullableText(value.fiscalYear) && ["xbrl", "filing_text", "call", "news", "web", "import"].includes(value.sourceKind)
    && nullableText(value.form) && (value.filedDate === null || date(value.filedDate)) && date(value.asOf)
    && finite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && text(value.quote) && value.quote.trim().length > 0 && nullableText(value.quoteLanguage)
    && [null, "exact", "whitespace", "nfkc_whitespace"].includes(value.quoteMatchMode)
    && url(value.filingUrl) && nullableText(value.accession);
}
export function validateSupplyChain(data: SupplyChainPayload): SupplyChainPayload {
  const valid = !!data && text(data.symbol) && (data.entity === null || entity(data.entity))
    && (data.asOf === null || date(data.asOf)) && ["available", "unavailable"].includes(data.status)
    && ["says", "names"].every((view) => {
      const key = view as "says" | "names";
      const rows = data[key];
      return Array.isArray(rows) && rows.every(row) && new Set(rows.map((entry) => entry.id)).size === rows.length
        && SUPPLY_ROLES.every((role) => Number.isInteger(data.counts?.[key]?.[role])
          && data.counts[key][role] >= rows.filter((entry) => entry.role === role).length);
    }) && Number.isInteger(data.totalRows) && data.totalRows >= data.says.length + data.names.length
    && ["full", "preview"].includes(data.access) && Number.isInteger(data.lockedRows) && data.lockedRows >= 0
    && typeof data.truncated === "boolean" && [3, null].includes(data.previewRowsPerRole)
    && text(data.disclaimer);
  if (!valid) throw new Error("The server returned unreadable supply chain disclosures");
  return data;
}
export async function fetchSupplyChain(symbol: string, client: Pick<typeof apiClient, "getCloudSupplyChain"> = apiClient) {
  try { return validateSupplyChain(await client.getCloudSupplyChain(symbol)); }
  catch (error) { throw unavailableOnServer(error, SUPPLY_UNAVAILABLE, [404, 503]); }
}
// Account and plan belong in the key: signing out must never reveal a paid cached response.
const cacheKey = (symbol: string, access: string) => `${symbol.toUpperCase()}:${access}`;
export const cachedSupplyChain = (symbol: string, access: string) => cachedCloudResource(supplyChainCache, cacheKey(symbol, access), validateSupplyChain);
export const loadSupplyChain = (symbol: string, access: string, force = false) => loadCloudResource(supplyChainCache, cacheKey(symbol, access), () => fetchSupplyChain(symbol), { force, validate: validateSupplyChain });
