import { apiClient } from "../../../api-client";
import { DEFAULT_GRAPH_OPTIONS, supplyGraphQuery, type GraphOptions, type GraphPayload, type GraphPath } from "../../../api-client/supply-chain-graph";
import { dateOptionError, readCalendarDate } from "../../../utils/calendar-date";
import { isCalendarDay, isFraction, isNullableCalendarDay } from "../../../utils/guards";
import { batchReplyItems, createCloudBatchAhead, createCloudEndpoint } from "../shared/cloud-resource";
import { laterSupplyEvidence, normalizeSupplyRow, validPeriodMonths, validSupplyEntity, validSupplyRow } from "./client";
import { graphEvidenceRow } from "./graph-evidence";
import { activeRelationship, isUnconfirmed } from "./trust";

const id = (x: unknown): x is string => typeof x === "string" && x.length > 0;
export function validateGraph(data: GraphPayload, requestedCutoff?: string): GraphPayload {
  try {
    if (!data || !id(data.symbol) || !["available", "unavailable"].includes(data.status) || !["full", "preview"].includes(data.access)
      || !Array.isArray(data.nodes) || !data.nodes.every(validSupplyEntity) || !Array.isArray(data.links)
      || typeof data.truncated !== "boolean" || typeof data.search?.complete !== "boolean" || !Array.isArray(data.search.reasons)
      || !data.search.reasons.every(id) || !Number.isFinite(Date.parse(data.snapshotAt)) || !isNullableCalendarDay(data.asOf)) throw 0;
    const nodes = new Set(data.nodes.map(node => node.id));
    const links = new Map(data.links.map(link => [link.id, link]));
    if (nodes.size !== data.nodes.length || links.size !== data.links.length || (data.entity && !nodes.has(data.entity.id))
      || (data.target && !validSupplyEntity(data.target))) throw 0;
    for (const link of data.links) {
      if (!id(link.id) || !nodes.has(link.from) || !nodes.has(link.to) || !isFraction(link.confidence) || !isFraction(link.weight)
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
      if (!id(entry.id) || !Number.isInteger(entry.hops) || entry.hops < 1 || entry.hops > 4 || !isFraction(entry.score) || !isFraction(entry.confidence)
        || entry.linkIds.length !== entry.hops || entry.nodeIds.length !== entry.hops + 1 || new Set(entry.nodeIds).size !== entry.nodeIds.length
        || !entry.nodeIds.every(node => nodes.has(node))) throw 0;
      entry.linkIds.forEach((key, index) => {
        const link = links.get(key), a = entry.nodeIds[index], b = entry.nodeIds[index + 1];
        if (!link || !(link.from === a && link.to === b || link.to === a && link.from === b)) throw 0;
      });
      if (entry.exposure && (entry.linkIds.some(id => graphEvidenceRow(links.get(id)!.evidence.find(item => item.id === links.get(id)!.primaryEvidenceId)!).tier !== 1) || entry.exposure.estimated !== entry.hops > 1 || !Number.isFinite(entry.exposure.pct) || entry.exposure.pct < 0 || entry.exposure.pct > 100
        || !entry.nodeIds.includes(entry.exposure.denominatorEntityId) || !["revenue", "receivables", "cost", "purchases"].includes(entry.exposure.basis) || !validPeriodMonths(entry.exposure.periodMonths))) throw 0;
    };
    data.paths.forEach(path);
    for (const entry of [...data.upstream, ...data.downstream, ...data.related]) {
      if (!nodes.has(entry.entityId)) throw 0;
      path(entry.bestPath); path(entry.shortestPath);
    }
    const o = data.options;
    if (!Number.isInteger(o.depth) || o.depth < 1 || o.depth > 4 || !["both", "upstream", "downstream"].includes(o.direction)
      || !isFraction(o.minConfidence) || !Number.isFinite(o.minPct) || o.minPct < 0 || o.minPct > 100 || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > 50
      || !["score", "shortest"].includes(o.ranking) || ![o.roles, o.sources, o.tiers].every(Array.isArray)
      || (o.asOf !== undefined && !isCalendarDay(o.asOf))) throw 0;
  } catch { throw new Error("The server returned an unreadable supply chain graph"); }
  const echoed = data.options.asOf;
  const latestPreview = data.access === "preview" && !echoed;
  if (requestedCutoff && echoed !== requestedCutoff && !latestPreview) {
    throw new Error(`Supply chain graph did not return the requested filing cutoff ${requestedCutoff}; none is shown.`);
  }
  const cutoff = latestPreview ? undefined : requestedCutoff ?? echoed;
  if (cutoff) {
    const futureExposure = ({ exposure }: GraphPath) => isCalendarDay(exposure?.period) && exposure.period > cutoff;
    if ((data.asOf && data.asOf > cutoff)
      || data.links.some(link => link.evidence.some(item => laterSupplyEvidence(graphEvidenceRow(item), cutoff)))
      || data.paths.some(futureExposure)
      || [...data.upstream, ...data.downstream, ...data.related].some(reach => futureExposure(reach.bestPath) || futureExposure(reach.shortestPath))) {
      throw new Error(`Supply chain graph returned disclosures published after ${cutoff}; none are shown.`);
    }
  }
  return { ...data, links: data.links.map(link => ({ ...link, evidence: link.evidence.map(item => {
    const row = normalizeSupplyRow(graphEvidenceRow(item));
    return { ...item, trustTier: row.tier, quote: row.quote, quoteLanguage: row.quoteLanguage, quoteGloss: row.quoteGloss,
      pctOfRevenue: row.pctOfRevenue, pctBasis: row.pctBasis, pctScope: row.pctScope,
      usd: row.usd, usdBasis: row.usdBasis, nativeAmount: row.nativeAmount, nativeCurrency: row.nativeCurrency, nativeScale: row.nativeScale,
      lastConfirmedAt: row.lastConfirmedAt, evidence: row.evidence };
  }) })) };
}
const key = (symbol: string, target: string, options: Partial<GraphOptions>, access = "") => `${access}:${symbol.toUpperCase()}:${target.toUpperCase()}:${supplyGraphQuery(options)}`;
const graphEndpoint = createCloudEndpoint<{ symbol: string; target: string; options: Partial<GraphOptions>; access?: string }, GraphPayload, Pick<typeof apiClient, "getCloudSupplyGraph" | "getCloudSupplyPaths">>({
  kind: "supply-graph", schemaVersion: 2, policy: { staleMs: 300_000, expireMs: 86_400_000 },
  key: ({ symbol, target, options, access }) => key(symbol, target, options, access),
  defaultClient: apiClient,
  fetch: ({ symbol, target, options }, client) => target ? client.getCloudSupplyPaths(symbol, target, options) : client.getCloudSupplyGraph(symbol, options),
  validate: (data, { options }) => validateGraph(data, options.asOf), unavailableMessage: "Supply chain graph is not available yet.", unavailableStatuses: [404, 503],
});
export const graphCache = graphEndpoint.cache;
export const fetchSupplyGraph = (symbol: string, options: Partial<GraphOptions> = {}, target = "", client: Pick<typeof apiClient, "getCloudSupplyGraph" | "getCloudSupplyPaths"> = apiClient) =>
  graphEndpoint.fetch({ symbol, target, options }, { client });
export const cachedGraph = (symbol: string, target: string, options: GraphOptions, access: string) =>
  graphEndpoint.cached({ symbol, target, options, access });
export const loadGraph = (symbol: string, target: string, options: GraphOptions, access: string, force = false) =>
  graphEndpoint.load({ symbol, target, options, access }, { force });
export function supplyCutoff(input: Record<string, unknown>, paneCutoff?: unknown): string | undefined {
  const asOfText = String(input.asOf || input["as-of"] || paneCutoff || "").trim();
  const asOf = asOfText ? readCalendarDate(asOfText) : null;
  if (asOfText && !asOf) throw new Error(dateOptionError(asOfText, "", { subject: "a filing cutoff" }));
  return asOf ?? undefined;
}
export function graphOptions(input: Record<string, unknown>): GraphOptions {
  const asOf = supplyCutoff(input);
  const csv = (key: string) => String(input[key] ?? "").split(",").filter(Boolean);
  const options = { ...DEFAULT_GRAPH_OPTIONS, depth: Number(input.depth ?? 2), direction: String(input.direction ?? "both") as GraphOptions["direction"],
    roles: csv("roles") as GraphOptions["roles"], sources: csv("sources") as GraphOptions["sources"], tiers: csv("tiers") as GraphOptions["tiers"],
    minPct: Number(input.minPct ?? input["min-pct"] ?? 0), minConfidence: Number(input.minConfidence ?? input["min-confidence"] ?? 0), limit: Number(input.limit ?? 50),
    ranking: String(input.ranking ?? "score") as GraphOptions["ranking"], ...(asOf ? { asOf } : {}) };
  if (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 4 || !["both", "upstream", "downstream"].includes(options.direction)
    || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50 || !["score", "shortest"].includes(options.ranking)
    || !isFraction(options.minConfidence) || !Number.isFinite(options.minPct) || options.minPct < 0 || options.minPct > 100
    || options.roles.some(value => !["customer", "supplier", "partner", "competitor", "investee"].includes(value))
    || options.sources.some(value => !["xbrl", "filing_text", "call", "news", "web", "import", "press_release"].includes(value))
    || options.tiers.some(value => !["structured", "primary", "secondary", "imported"].includes(value))) throw new Error("Invalid supply chain graph filters");
  return options;
}
/** Symbols per graphs batch request: a ripple's sixty holdings are two, read sixteen at a time on the server. */
const GRAPH_BATCH_MAX = 30;
const graphsAheadByOptions = new Map<string, ReturnType<typeof createCloudBatchAhead<GraphPayload>>>();
/**
 * Reads many symbols' graphs on one query ahead in a request per 30 (EARN
 * ripple's two hops), into the cache loadGraph reads. Answers the symbols stored.
 */
export function loadGraphsAhead(symbols: readonly string[], options: GraphOptions, access: string, force = false): Promise<Set<string>> {
  const query = supplyGraphQuery(options);
  let ahead = graphsAheadByOptions.get(query);
  if (!ahead) {
    ahead = createCloudBatchAhead(graphCache, {
      max: GRAPH_BATCH_MAX,
      validate: data => validateGraph(data, options.asOf),
      read: async (ids) => batchReplyItems(await apiClient.getCloudSupplyGraphs(ids, options))
        .flatMap((item) => item.graph ? [{ id: item.symbol.toUpperCase(), payload: item.graph }] : []),
    });
    graphsAheadByOptions.set(query, ahead);
  }
  return ahead(symbols.map((symbol) => ({ id: symbol.toUpperCase(), key: key(symbol, "", options, access) })), force);
}
