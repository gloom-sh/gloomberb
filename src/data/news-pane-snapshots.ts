import type { AppResourceStorePort } from "../core/app-service-ports";
import { hashString } from "../news/rss-hash";
import { parseNewsIndustryCode } from "../news/query-presets";
import type { PaneInstanceConfig, SavedLayout } from "../types/config";
import { isRecord } from "../utils/guards";
import { logFailure } from "../utils/log-failure";
import { packJson, unpackJson } from "./packed-json";
import { stampRetrievedAt } from "./saved-copies";

const PUBLIC_LEGACY_SCOPE = "legacy-public";
const MAX_ARTICLES = 200;
const MAX_BYTES = 256 * 1024;
const CACHE_POLICY = { staleMs: 0, expireMs: 30 * 24 * 60 * 60_000 };
const encoder = new TextEncoder();

function snapshotSlot(pane: PaneInstanceConfig, owner: string, key: string): string | null {
  if (pane.paneId === "ticker-research" || pane.paneId === "ticker-news") {
    if (owner !== "news" && (pane.paneId !== "ticker-research"
      || !["ticker-core", "ticker-research", "ticker-detail"].includes(owner))) return null;
    return /^articles:[^:]+:[^:]*(?::v\d+|-v\d+)?$/.test(key) ? "ticker" : null;
  }
  if (owner !== "news") return null;
  switch (pane.paneId) {
    case "news-top": return /^top:curated:articles(?::v\d+|-v\d+)?$/.test(key) ? "list" : null;
    case "news-feed": return /^feed:articles(?::v\d+|-v\d+)?$/.test(key) ? "list" : null;
    case "news-breaking": return /^breaking:articles(?::v\d+|-v\d+)?$/.test(key) ? "list" : null;
    case "news-industry":
      if (/^industry:topic:[^:]+:articles(?::v\d+|-v\d+)?$/.test(key)) return "topic";
      return /^industry:sector:all:articles(?::v\d+|-v\d+)?$/.test(key) ? "sector" : null;
    default: return null;
  }
}

type SnapshotTarget = { pane: PaneInstanceConfig; owner: string; key: string };

function resourceKey({ pane, owner, key }: SnapshotTarget, scope: string) {
  const kind = snapshotSlot(pane, owner, key);
  return kind && { namespace: "pane:news", kind, entityKey: JSON.stringify([pane.paneId, pane.instanceId]), sourceKey: scope };
}

export function readNewsPaneSnapshot<T>(store: AppResourceStorePort, target: SnapshotTarget, scope: string | null): T[] | null {
  const resource = resourceKey(target, PUBLIC_LEGACY_SCOPE);
  if (!resource) return null;
  try {
    const record = (scope == null ? null : store.get<string>({ ...resource, sourceKey: scope })) ?? store.get<string>(resource);
    if (!record) return null;
    const [key, articles] = JSON.parse(unpackJson(record.value));
    return key === target.key && Array.isArray(articles) ? stampRetrievedAt(articles, record.fetchedAt) : null;
  } catch (error) {
    logFailure("data.news-pane-snapshots", "Reading saved headlines failed")(error);
    return null;
  }
}

export function writeNewsPaneSnapshot(store: AppResourceStorePort, target: SnapshotTarget, scope: string, articles: unknown[]): void {
  const resource = resourceKey(target, scope);
  if (!resource || !articles.length) return;
  try {
    const kept = [];
    let bytes = encoder.encode(JSON.stringify(target.key)).byteLength + 4;
    for (const article of articles.slice(0, MAX_ARTICLES)) {
      const json = JSON.stringify(article);
      if (!json) continue;
      bytes += encoder.encode(json).byteLength + 1;
      if (bytes > MAX_BYTES) break;
      kept.push(json);
    }
    if (!kept.length) return;
    const packed = packJson(`[${JSON.stringify(target.key)},[${kept.join(",")}]]`);
    if (store.get<string>(resource, { touch: false })?.value === packed) return;
    store.set(resource, packed, { cachePolicy: CACHE_POLICY });
  } catch (error) {
    logFailure("data.news-pane-snapshots", "Saving headlines failed")(error);
  }
}

type LegacySnapshot = SnapshotTarget & { articles: unknown[] };
const legacySeeds = new WeakMap<NonNullable<SavedLayout["paneState"]>, LegacySnapshot[]>();

function isPublicRssArticle(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.url === "string" && typeof value.title === "string"
    && typeof value.publishedAt === "string" && typeof value.source === "string" && Array.isArray(value.tickers)
    && Array.isArray(value.sectors) && value.items == null && value.routine == null && value.insiderFilings == null
    && (value.id.startsWith("atom:") || value.id === hashString(`${value.url}|${value.title}`));
}

export function stripLegacyNewsSnapshots(layout: SavedLayout, keepPublicSeed = false): SavedLayout {
  if (!layout.paneState) return layout;
  const seeds: LegacySnapshot[] = [];
  let paneState = layout.paneState;
  for (const pane of layout.layout.instances) {
    const state = paneState[pane.instanceId];
    if (!isRecord(state?.pluginState)) continue;
    let pluginState = state.pluginState;
    const seenSlots = new Set<string>();
    for (const [owner, values] of Object.entries(state.pluginState)) {
      if (!isRecord(values)) continue;
      let kept = values;
      for (const [key, value] of Object.entries(values).reverse()) {
        const slot = snapshotSlot(pane, owner, key);
        if (!slot) continue;
        if (kept === values) kept = { ...values };
        delete kept[key];
        if (!keepPublicSeed || seenSlots.has(slot) || !key.endsWith(":v2") || !Array.isArray(value)) continue;
        if (slot === "topic") {
          const code = values["industry:category"];
          const active = parseNewsIndustryCode(typeof code === "string" ? code : pane.params?.code);
          if (key !== `industry:topic:${active?.topic}:articles:v2`) continue;
        }
        const articles = value.slice(0, MAX_ARTICLES).filter(isPublicRssArticle);
        if (!articles.length) continue;
        seenSlots.add(slot);
        seeds.push({ pane, owner, key, articles });
      }
      if (kept === values) continue;
      if (pluginState === state.pluginState) pluginState = { ...state.pluginState };
      if (Object.keys(kept).length) pluginState[owner] = kept;
      else delete pluginState[owner];
    }
    if (pluginState === state.pluginState) continue;
    if (paneState === layout.paneState) paneState = { ...layout.paneState };
    const { pluginState: _old, ...rest } = state;
    paneState[pane.instanceId] = Object.keys(pluginState).length ? { ...rest, pluginState } : rest;
  }
  if (paneState === layout.paneState) return layout;
  const cleaned = { ...layout, paneState };
  if (seeds.length) legacySeeds.set(paneState, seeds);
  return cleaned;
}

export function seedLegacyNewsSnapshots(store: AppResourceStorePort, layouts: SavedLayout[], activeLayoutIndex: number): void {
  const active = layouts[activeLayoutIndex];
  for (const layout of active ? [active, ...layouts.filter((entry) => entry !== active)] : layouts) {
    const paneState = layout.paneState;
    if (!paneState) continue;
    const seeds = legacySeeds.get(paneState);
    if (!seeds) continue;
    legacySeeds.delete(paneState);
    for (const seed of seeds) {
      const resource = resourceKey(seed, PUBLIC_LEGACY_SCOPE);
      if (resource && !store.get(resource, { touch: false })) {
        writeNewsPaneSnapshot(store, seed, PUBLIC_LEGACY_SCOPE, seed.articles);
      }
    }
  }
}
