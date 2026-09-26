import type { LayoutConfig } from "../types/config";
import {
  isMarketplaceLayoutId,
  type LayoutMarketplaceAuthor,
  type LayoutMarketplacePayload,
  parseMarketplaceLayoutPayload,
} from "./payload";

export type CloudLayoutVisibility = "private" | "team" | "public";

export interface LayoutRequirement {
  pluginId: string;
  repo?: string;
  minVersion?: string;
}

/** The full shape the server answers with on `?v=2` and every new route. */
export interface CloudLayoutEntry extends LayoutMarketplacePayload {
  id: string;
  name: string;
  owner: { kind: "user" | "team"; id: string };
  visibility: CloudLayoutVisibility;
  revision: number;
  paneIds: string[];
  requires: LayoutRequirement[];
  note: string | null;
  author: LayoutMarketplaceAuthor;
  createdBy: string;
  publishedAt: string;
  updatedAt: string;
}

/** A publish refused because someone published in between. */
export class LayoutRevisionConflictError extends Error {
  constructor(
    message: string,
    public readonly currentRevision: number,
  ) {
    super(message);
    this.name = "LayoutRevisionConflictError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAuthor(value: unknown): LayoutMarketplaceAuthor | null {
  if (!record(value)) return null;
  if (value.username !== null && typeof value.username !== "string") return null;
  if (typeof value.displayName !== "string" || !value.displayName) return null;
  return { username: value.username as string | null, displayName: value.displayName };
}

export function parseLayoutRequirements(value: unknown): LayoutRequirement[] {
  if (!Array.isArray(value)) return [];
  const requires: LayoutRequirement[] = [];
  for (const entry of value) {
    if (!record(entry) || typeof entry.pluginId !== "string" || !entry.pluginId) continue;
    requires.push({
      pluginId: entry.pluginId,
      ...(typeof entry.repo === "string" && entry.repo ? { repo: entry.repo } : {}),
      ...(typeof entry.minVersion === "string" && entry.minVersion ? { minVersion: entry.minVersion } : {}),
    });
  }
  return requires;
}

/**
 * Lenient about extra keys, unlike the legacy parser: the full shape grows as
 * the server does, and a terminal must not reject a layout because the
 * server learned a new field.
 */
export function parseCloudLayoutEntry(value: unknown): CloudLayoutEntry | null {
  if (!record(value)) return null;
  if (typeof value.id !== "string" || !isMarketplaceLayoutId(value.id)) return null;
  if (typeof value.name !== "string" || !value.name) return null;
  if (!record(value.owner) || (value.owner.kind !== "user" && value.owner.kind !== "team") || typeof value.owner.id !== "string") return null;
  if (value.visibility !== "private" && value.visibility !== "team" && value.visibility !== "public") return null;
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1) return null;
  const author = parseAuthor(value.author);
  if (!author) return null;
  if (typeof value.publishedAt !== "string" || Number.isNaN(Date.parse(value.publishedAt))) return null;
  const payload = parseMarketplaceLayoutPayload({
    schemaVersion: value.schemaVersion,
    sourceConfigVersion: value.sourceConfigVersion,
    layout: value.layout,
    ...(value.schemaVersion === 2 ? { paneState: value.paneState } : {}),
  });
  if (!payload) return null;
  return {
    id: value.id,
    name: value.name,
    owner: { kind: value.owner.kind, id: value.owner.id },
    visibility: value.visibility,
    revision: value.revision,
    paneIds: Array.isArray(value.paneIds) ? value.paneIds.filter((id): id is string => typeof id === "string") : payload.layout.instances.map((instance) => instance.paneId),
    requires: parseLayoutRequirements(value.requires),
    note: typeof value.note === "string" ? value.note : null,
    author,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : "",
    publishedAt: value.publishedAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : value.publishedAt,
    ...payload,
  };
}

export function parseCloudLayoutList(value: unknown): CloudLayoutEntry[] | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  const items = value.items.map(parseCloudLayoutEntry);
  return items.every((item): item is CloudLayoutEntry => item !== null) ? items : null;
}

// Content fingerprint

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** FNV-1a over UTF-16 code units; stable, fast, and good enough to spot drift. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Hashes the content of a publishable payload: pane instances with their
 * bindings, params, settings, and publishable state. The dock tree and
 * floating geometry are left out on purpose; where panes sit is personal.
 * Instances are keyed by what they are, not by their wire id, so reordering
 * the instance list does not read as an edit.
 */
export function layoutContentFingerprint(payload: Pick<LayoutMarketplacePayload, "layout" | "paneState">): string {
  const byId = new Map(payload.layout.instances.map((instance) => [instance.instanceId, instance]));
  const describe = (instanceId: string): string => {
    const instance = byId.get(instanceId);
    return instance ? `${instance.paneId}|${instance.title ?? ""}` : instanceId;
  };
  const items = payload.layout.instances.map((instance) => canonicalJson({
    paneId: instance.paneId,
    title: instance.title ?? null,
    binding: instance.binding?.kind === "follow"
      ? { kind: "follow", source: describe(instance.binding.sourceInstanceId) }
      : (instance.binding ?? null),
    params: instance.params ?? null,
    settings: instance.settings ?? null,
    state: payload.paneState[instance.instanceId] ?? null,
  })).sort();
  return `${items.length.toString(16)}-${fnv1a(items.join("\n"))}`;
}


/**
 * The plugins a layout needs beyond the built-ins, from the pane registry's
 * owner map. External plugins carry their repo so a teammate can install
 * them from the placeholder.
 */
export function computeLayoutRequirements(
  layout: LayoutConfig,
  options: {
    panePluginId: (paneId: string) => string | undefined;
    pluginInfo: (pluginId: string) => { repo?: string; version?: string; builtin?: boolean } | null;
  },
): LayoutRequirement[] {
  const seen = new Map<string, LayoutRequirement>();
  for (const instance of layout.instances) {
    const pluginId = options.panePluginId(instance.paneId);
    if (!pluginId || seen.has(pluginId)) continue;
    const info = options.pluginInfo(pluginId);
    if (!info || info.builtin) continue;
    seen.set(pluginId, {
      pluginId,
      ...(info.repo ? { repo: info.repo } : {}),
      ...(info.version ? { minVersion: info.version } : {}),
    });
  }
  return [...seen.values()];
}
