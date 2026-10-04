import { apiClient } from "../../../api-client";
import type { PowerBoard, PowerDetail, PowerFilter, PowerHistory, PowerProject } from "../../../api-client/power";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

const cacheOptions = { source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 } };
export const powerBoardCache = createPluginCache<PowerBoard>({ ...cacheOptions, kind: "power-board" });
export const powerHistoryCache = createPluginCache<PowerHistory>({ ...cacheOptions, kind: "power-history" });
export const powerDetailCache = createPluginCache<PowerDetail>({ ...cacheOptions, kind: "power-detail" });
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const nullableText = (v: unknown) => v === null || text(v);
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v: unknown) => nonnegative(v) && Number.isInteger(v);
const instant = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const url = (v: unknown) => { try { return text(v) && new URL(v).protocol === "https:"; } catch { return false; } };
const access = (v: unknown) => v === "full" || v === "preview";
const entities = (v: unknown) => Array.isArray(v) && v.every((e) => record(e) && text(e.name) && text(e.entityId)
  && ["utility", "developer"].includes(e.role) && nonnegative(e.confidence) && e.confidence <= 1
  && Array.isArray(e.tickers) && e.tickers.every((t: unknown) => record(t) && text(t.ticker) && (t.exchange === undefined || text(t.exchange))));
function project(v: unknown): v is PowerProject {
  return record(v) && [v.id, v.name, v.sourceId, v.sourceProjectId, v.country, v.region, v.sourceLocator, v.snapshotId].every(text)
    && ["queue", "load", "capacity", "utility"].includes(v.kind) && ["active", "completed", "withdrawn", "approved", "operating", "unknown"].includes(v.status)
    && ["solar", "wind", "storage", "gas", "nuclear", "hydro", "coal", "hybrid", "other", "load", "unknown"].includes(v.fuel)
    && [v.state, v.county, v.zone, v.developer, v.utility, v.technology, v.statusRaw, v.requestedDate, v.proposedDate, v.completedDate, v.withdrawnDate, v.period, v.asOf].every(nullableText)
    && (v.capacityMw === null || nonnegative(v.capacityMw)) && instant(v.observedAt) && url(v.sourceUrl) && nonnegative(v.confidence) && v.confidence <= 1
    && integer(v.revision) && record(v.evidence) && record(v.metrics) && typeof v.historical === "boolean" && entities(v.entities);
}
const aggregate = (v: unknown) => record(v) && [v.sourceId, v.country, v.region, v.fuel, v.status, v.kind].every(text)
  && integer(v.projects) && nonnegative(v.capacityMw) && integer(v.unknownCapacity);
export function validatePowerBoard(data: PowerBoard): PowerBoard {
  if (!record(data) || !instant(data.generatedAt) || !access(data.access) || !Array.isArray(data.projects) || !data.projects.every(project)
    || new Set(data.projects.map((r) => r.id)).size !== data.projects.length || !integer(data.total) || data.total < data.projects.length
    || typeof data.hasMore !== "boolean" || !(data.nextOffset === null || integer(data.nextOffset))
    || !Array.isArray(data.aggregates) || !data.aggregates.every(aggregate)
    || !Array.isArray(data.rates) || !data.rates.every((v) => record(v) && [v.sourceId, v.region, v.country, v.cohort].every(text)
      && [v.projects, v.completed, v.withdrawn, v.active, v.unknown].every(integer)
      && [v.completionRate, v.withdrawalRate].every((n) => n === null || nonnegative(n) && n <= 1))
    || !Array.isArray(data.exposure) || !data.exposure.every((v) => record(v) && [v.sourceId, v.utility, v.country, v.region].every(text) && Array.isArray(v.sourceUrls) && v.sourceUrls.every(url) && nullableText(v.asOf) && instant(v.observedAt)
      && [v.requestedMw, v.approvedMw, v.operatingMw].every(nonnegative) && integer(v.requests) && integer(v.unknownCapacity) && entities(v.entities))
    || !Array.isArray(data.coverage) || !data.coverage.every((v) => record(v) && [v.id, v.country, v.region].every(text)
      && ["current", "stale", "pending", "failed", "disabled"].includes(v.status) && nullableText(v.reason) && url(v.sourceUrl)
      && nullableText(v.asOf) && (v.observedAt === null || instant(v.observedAt)) && integer(v.records))
    || !record(data.filters) || ![data.filters.countries, data.filters.regions, data.filters.fuels, data.filters.statuses].every((v) => Array.isArray(v) && v.every(text))
    || !record(data.locked) || ![data.locked.projects, data.locked.aggregates, data.locked.rates, data.locked.exposure].every(integer))
    throw new Error("The server returned unreadable power data.");
  if (data.hasMore && (data.nextOffset === null || data.projects.length === 0)) throw new Error("The server returned an invalid power page.");
  return data;
}
export function validatePowerHistory(data: PowerHistory): PowerHistory {
  if (!record(data) || !instant(data.generatedAt) || !access(data.access) || !integer(data.locked) || !Array.isArray(data.points)
    || typeof data.hasMore !== "boolean" || !(data.nextOffset === null || integer(data.nextOffset))
    || data.hasMore && (data.nextOffset === null || !data.points.length)
    || !data.points.every((p) => aggregate(p) && ["published", "observed"].includes(p.basis) && Array.isArray(p.sourceUrls) && p.sourceUrls.every(url) && text(p.sourceId) && instant(p.observedAt) && nullableText(p.asOf) && nullableText(p.period) && typeof p.historical === "boolean"))
    throw new Error("The server returned unreadable power history.");
  return data;
}
function validateDetail(data: PowerDetail): PowerDetail {
  if (!record(data) || !instant(data.generatedAt) || !access(data.access) || !integer(data.locked)
    || !(data.project === null || project(data.project)) || !Array.isArray(data.revisions) || !data.revisions.every(project)
    || !integer(data.totalRevisions) || data.totalRevisions < data.revisions.length || typeof data.hasMore !== "boolean"
    || !(data.nextOffset === null || integer(data.nextOffset)) || data.hasMore && (data.nextOffset === null || !data.revisions.length))
    throw new Error("The server returned unreadable project evidence.");
  return data;
}
type PowerApi = Pick<typeof apiClient, "getCloudPowerBoard" | "getCloudPowerHistory" | "getCloudPowerProject">;
export async function fetchPowerBoard(filter: PowerFilter, client: Pick<PowerApi, "getCloudPowerBoard"> = apiClient, signal?: AbortSignal) {
  try { const data = validatePowerBoard(await client.getCloudPowerBoard(filter, signal));
    if (data.hasMore && data.nextOffset! <= (filter.offset ?? 0)) throw new Error("Power pagination did not advance.");
    return data; }
  catch (error) { throw unavailableOnServer(error, "Power data is not available yet.", [404, 503]); }
}
async function fetchPowerHistory(filter: PowerFilter, client: Pick<PowerApi, "getCloudPowerHistory"> = apiClient) {
  const data = validatePowerHistory(await client.getCloudPowerHistory(filter));
  if (data.hasMore && data.nextOffset! <= (filter.offset ?? 0)) throw new Error("Power history pagination did not advance.");
  return data;
}
export async function fetchAllPowerHistory(filter: PowerFilter, client: Pick<PowerApi, "getCloudPowerHistory"> = apiClient) {
  const first = await fetchPowerHistory({ ...filter, limit: 500 }, client);
  const points = [...first.points];
  let page = first;
  let offset = 0;
  while (page.hasMore) {
    if (page.nextOffset === null || page.nextOffset <= offset) throw new Error("Power history pagination did not advance.");
    offset = page.nextOffset;
    page = await fetchPowerHistory({ ...filter, offset, limit: 500 }, client);
    points.push(...page.points);
  }
  return { ...first, points, hasMore: false, nextOffset: null };
}
const key = (query: unknown, scope: string) => `${scope}:${JSON.stringify(query)}`;
export const loadPowerBoard = (filter: PowerFilter, scope: string, force = false, signal?: AbortSignal) =>
  loadCloudResource(powerBoardCache, key(filter, scope), () => fetchPowerBoard(filter, apiClient, signal), { force, validate: validatePowerBoard });
export const loadPowerHistory = (filter: PowerFilter, scope: string, force = false) =>
  loadCloudResource(powerHistoryCache, key(filter, scope), () => fetchPowerHistory(filter), { force, validate: validatePowerHistory });
export const loadPowerDetail = (id: string, scope: string, force = false, offset = 0, signal?: AbortSignal) => loadCloudResource(powerDetailCache, key({ id, offset }, scope),
  async () => { const value = validateDetail(await apiClient.getCloudPowerProject(id, { offset, limit: 100 }, signal));
    if (value.hasMore && value.nextOffset! <= offset) throw new Error("Project revision pagination did not advance.");
    if (value.project && value.project.id !== id || value.revisions.some((r) => r.id !== id)) throw new Error("Project evidence belongs to a different project.");
    return value; }, { force, validate: validateDetail });
