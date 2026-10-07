import { apiClient } from "../../../api-client";
import { DEFAULT_GRAPH_OPTIONS, supplyGraphQuery, type GraphOptions, type GraphPayload, type GraphPath } from "../../../api-client/supply-chain-graph";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { normalizeSupplyRow, validSupplyEntity, validSupplyRow } from "./client";
import { graphEvidenceRow } from "./graph-evidence";
import { activeRelationship, isUnconfirmed } from "./trust";

export const graphCache = createPluginCache<GraphPayload>({ kind: "supply-graph", source: "gloom-cloud", schemaVersion: 2, policy: { staleMs: 300_000, expireMs: 86_400_000 } });
const unit = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const id = (x: unknown): x is string => typeof x === "string" && x.length > 0;
export function validateGraph(data: GraphPayload): GraphPayload {
  try {
    if (!data || !id(data.symbol) || !["available", "unavailable"].includes(data.status) || !["full", "preview"].includes(data.access)
      || !Array.isArray(data.nodes) || !data.nodes.every(validSupplyEntity) || !Array.isArray(data.links)
      || typeof data.truncated !== "boolean" || typeof data.search?.complete !== "boolean" || !Array.isArray(data.search.reasons)
      || !data.search.reasons.every(id) || !Number.isFinite(Date.parse(data.snapshotAt))) throw 0;
    const nodes = new Set(data.nodes.map(node => node.id));
    const links = new Map(data.links.map(link => [link.id, link]));
    if (nodes.size !== data.nodes.length || links.size !== data.links.length || (data.entity && !nodes.has(data.entity.id))
      || (data.target && !validSupplyEntity(data.target))) throw 0;
    for (const link of data.links) {
      if (!id(link.id) || !nodes.has(link.from) || !nodes.has(link.to) || !unit(link.confidence) || !unit(link.weight)
        || !["commerce", "partner", "competitor", "investee"].includes(link.relationship) || !Array.isArray(link.evidence)
        || !link.evidence.some(item => item.id === link.primaryEvidenceId)) throw 0;
      for (const item of link.evidence) {
        const row = graphEvidenceRow(item);
        if (!validSupplyRow(row) || !activeRelationship(row) || isUnconfirmed(row)
          || !validSupplyEntity(item.from) || !validSupplyEntity(item.to)
          || !["structured", "primary", "secondary", "imported"].includes(item.tier)) throw 0;
      }
    }
    const path = (entry: GraphPath) => {
      if (!id(entry.id) || !Number.isInteger(entry.hops) || entry.hops < 1 || entry.hops > 4 || !unit(entry.score) || !unit(entry.confidence)
        || entry.linkIds.length !== entry.hops || entry.nodeIds.length !== entry.hops + 1 || new Set(entry.nodeIds).size !== entry.nodeIds.length
        || !entry.nodeIds.every(node => nodes.has(node))) throw 0;
      entry.linkIds.forEach((key, index) => {
        const link = links.get(key), a = entry.nodeIds[index], b = entry.nodeIds[index + 1];
        if (!link || !(link.from === a && link.to === b || link.to === a && link.from === b)) throw 0;
      });
      if (entry.exposure && (entry.linkIds.some(id => graphEvidenceRow(links.get(id)!.evidence.find(item => item.id === links.get(id)!.primaryEvidenceId)!).tier !== 1) || entry.exposure.estimated !== true || !Number.isFinite(entry.exposure.pct) || entry.exposure.pct < 0 || entry.exposure.pct > 100
        || !entry.nodeIds.includes(entry.exposure.denominatorEntityId) || !["revenue", "receivables", "cost", "purchases"].includes(entry.exposure.basis))) throw 0;
    };
    data.paths.forEach(path);
    for (const entry of [...data.upstream, ...data.downstream, ...data.related]) {
      if (!nodes.has(entry.entityId)) throw 0;
      path(entry.bestPath); path(entry.shortestPath);
    }
    const o = data.options;
    if (!Number.isInteger(o.depth) || o.depth < 1 || o.depth > 4 || !["both", "upstream", "downstream"].includes(o.direction)
      || !unit(o.minConfidence) || !Number.isFinite(o.minPct) || o.minPct < 0 || o.minPct > 100 || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > 50
      || !["score", "shortest"].includes(o.ranking) || ![o.roles, o.sources, o.tiers].every(Array.isArray)) throw 0;
    return { ...data, links: data.links.map(link => ({ ...link, evidence: link.evidence.map(item => {
      const row = normalizeSupplyRow(graphEvidenceRow(item));
      return { ...item, trustTier: row.tier, quote: row.quote, quoteLanguage: row.quoteLanguage, quoteGloss: row.quoteGloss,
        pctOfRevenue: row.pctOfRevenue, pctBasis: row.pctBasis, pctScope: row.pctScope,
        usd: row.usd, usdBasis: row.usdBasis, nativeAmount: row.nativeAmount, nativeCurrency: row.nativeCurrency, nativeScale: row.nativeScale,
        lastConfirmedAt: row.lastConfirmedAt, evidence: row.evidence };
    }) })) };
  } catch { throw new Error("The server returned an unreadable supply chain graph"); }
}
export async function fetchSupplyGraph(symbol: string, options: Partial<GraphOptions> = {}, target = "", client: Pick<typeof apiClient, "getCloudSupplyGraph" | "getCloudSupplyPaths"> = apiClient) {
  try { return validateGraph(await (target ? client.getCloudSupplyPaths(symbol, target, options) : client.getCloudSupplyGraph(symbol, options))); }
  catch (error) { throw unavailableOnServer(error, "Supply chain graph is not available yet.", [404, 503]); }
}
const key = (symbol: string, target: string, options: GraphOptions, access: string) => `${access}:${symbol.toUpperCase()}:${target.toUpperCase()}:${supplyGraphQuery(options)}`;
export const cachedGraph = (symbol: string, target: string, options: GraphOptions, access: string) => cachedCloudResource(graphCache, key(symbol, target, options, access), validateGraph);
export const loadGraph = (symbol: string, target: string, options: GraphOptions, access: string, force = false) => loadCloudResource(graphCache, key(symbol, target, options, access), () => fetchSupplyGraph(symbol, options, target), { force, validate: validateGraph });
export function graphOptions(input: Record<string, unknown>): GraphOptions {
  const csv = (key: string) => String(input[key] ?? "").split(",").filter(Boolean);
  const options = { ...DEFAULT_GRAPH_OPTIONS, depth: Number(input.depth ?? 2), direction: String(input.direction ?? "both") as GraphOptions["direction"],
    roles: csv("roles") as GraphOptions["roles"], sources: csv("sources") as GraphOptions["sources"], tiers: csv("tiers") as GraphOptions["tiers"],
    minPct: Number(input.minPct ?? input["min-pct"] ?? 0), minConfidence: Number(input.minConfidence ?? input["min-confidence"] ?? 0), limit: Number(input.limit ?? 50),
    ranking: String(input.ranking ?? "score") as GraphOptions["ranking"], ...(input.asOf || input["as-of"] ? { asOf: String(input.asOf ?? input["as-of"]) } : {}) };
  if (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 4 || !["both", "upstream", "downstream"].includes(options.direction)
    || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50 || !["score", "shortest"].includes(options.ranking)
    || !unit(options.minConfidence) || !Number.isFinite(options.minPct) || options.minPct < 0 || options.minPct > 100
    || options.roles.some(value => !["customer", "supplier", "partner", "competitor", "investee"].includes(value))
    || options.sources.some(value => !["xbrl", "filing_text", "call", "news", "web", "import", "press_release"].includes(value))
    || options.tiers.some(value => !["structured", "primary", "secondary", "imported"].includes(value))
    || options.asOf && (!/^\d{4}-\d{2}-\d{2}$/.test(options.asOf) || !Number.isFinite(Date.parse(options.asOf)) || new Date(options.asOf).toISOString().slice(0, 10) !== options.asOf)) throw new Error("Invalid supply chain graph filters");
  return options;
}
