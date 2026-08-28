import type { PaneRuntimeState } from "../core/state/app/types";
import {
  CURRENT_CONFIG_VERSION,
  removePaneInstances,
  type DockLayoutNode,
  type LayoutConfig,
  type PaneBinding,
} from "../types/config";
import type {
  PaneDef,
  PaneSharePrivateFields,
} from "../types/plugin";

const MAX_LAYOUT_BYTES = 128 * 1024;
const MAX_INSTANCES = 40;
const MAX_DOCK_DEPTH = 20;
const MAX_ID_LENGTH = 160;
const MAX_PANE_ID_LENGTH = 120;
const MAX_SYMBOL_LENGTH = 64;
const MAX_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 100;
const MAX_COORDINATE = 100_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_KEYS = 512;
const MAX_JSON_ARRAY_ITEMS = 5_000;
const MAX_JSON_STRING_LENGTH = 16_384;
const WIRE_ID = /^p[1-9][0-9]*$/;
const MARKETPLACE_ID = /^[a-f0-9]{32}$/i;

const PRIVATE_FIELD_NAMES = new Set([
  "account",
  "accountid",
  "accounts",
  "accesstoken",
  "accessurl",
  "alerts",
  "apikey",
  "apisecret",
  "attachments",
  "authorization",
  "bankroll",
  "brokeraccountid",
  "brokeraccounts",
  "brokerid",
  "brokerinstanceid",
  "channelid",
  "clientid",
  "collectionid",
  "collectionsorts",
  "cookie",
  "costbasis",
  "credential",
  "credentials",
  "currentvalue",
  "datadir",
  "directory",
  "draft",
  "email",
  "filepath",
  "holdings",
  "localpath",
  "messages",
  "oauth",
  "password",
  "portfolio",
  "portfolioanalytics",
  "portfolioid",
  "portfolios",
  "positions",
  "privatekey",
  "prompt",
  "publicemail",
  "queryid",
  "refreshtoken",
  "secret",
  "session",
  "sessiontoken",
  "setuptoken",
  "shares",
  "targetmessageid",
  "token",
  "transcript",
  "userid",
  "visiblecollectionids",
  "watchlist",
  "watchlists",
]);

export type LayoutMarketplaceSchemaVersion = 1 | 2;
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface LayoutMarketplaceAuthor {
  username: string | null;
  displayName: string;
}

/** Internal normalized form. V1 responses are upgraded with an empty paneState map. */
export interface LayoutMarketplacePayload {
  schemaVersion: LayoutMarketplaceSchemaVersion;
  sourceConfigVersion: number;
  layout: LayoutConfig;
  paneState: Record<string, PaneRuntimeState>;
}

export interface LayoutMarketplaceEntry extends LayoutMarketplacePayload {
  id: string;
  name: string;
  author: LayoutMarketplaceAuthor;
  publishedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isPrivateMarketplaceField(key: string): boolean {
  const normalized = normalizedKey(key);
  return PRIVATE_FIELD_NAMES.has(normalized)
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("credential")
    || normalized.endsWith("cookie");
}

function parseJson(value: unknown, depth = 0): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= MAX_JSON_STRING_LENGTH ? value : undefined;
  if (depth >= MAX_JSON_DEPTH) return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) return undefined;
    const parsed = value.map((entry) => parseJson(entry, depth + 1));
    return parsed.some((entry) => entry === undefined) ? undefined : parsed as JsonValue[];
  }
  if (!record(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_KEYS) return undefined;
  const parsed: Record<string, JsonValue> = {};
  for (const [key, entry] of entries) {
    if (isPrivateMarketplaceField(key)) return undefined;
    const next = parseJson(entry, depth + 1);
    if (next === undefined) return undefined;
    parsed[key] = next;
  }
  return parsed;
}

function sanitizeJson(value: unknown, depth = 0): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= MAX_JSON_STRING_LENGTH ? value : undefined;
  if (depth >= MAX_JSON_DEPTH) return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) return undefined;
    const sanitized = value.map((entry) => sanitizeJson(entry, depth + 1));
    return sanitized.some((entry) => entry === undefined) ? undefined : sanitized as JsonValue[];
  }
  if (!record(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_KEYS) return undefined;
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, entry] of entries) {
    if (isPrivateMarketplaceField(key)) continue;
    const next = sanitizeJson(entry, depth + 1);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function parseRecord(value: unknown): Record<string, JsonValue> | null {
  if (!record(value)) return null;
  const parsed = parseJson(value);
  return parsed && !Array.isArray(parsed) && typeof parsed === "object"
    ? parsed as Record<string, JsonValue>
    : null;
}

function sanitizeRecord(
  value: Record<string, unknown> | undefined,
  privateFields: PaneSharePrivateFields | undefined,
): Record<string, JsonValue> | undefined {
  if (!value || privateFields === true) return undefined;
  const excluded = new Set(privateFields ?? []);
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (excluded.has(key) || isPrivateMarketplaceField(key)) continue;
    const next = sanitizeJson(entry);
    if (next !== undefined) sanitized[key] = next;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function parseBinding(value: unknown): PaneBinding | null {
  if (!record(value) || !boundedString(value.kind, 16)) return null;
  if (value.kind === "none" && exactKeys(value, ["kind"])) return { kind: "none" };
  if (value.kind === "fixed" && exactKeys(value, ["kind", "symbol"]) && boundedString(value.symbol, MAX_SYMBOL_LENGTH)) {
    const symbol = value.symbol.trim().toUpperCase();
    return symbol ? { kind: "fixed", symbol } : null;
  }
  if (
    value.kind === "follow"
    && exactKeys(value, ["kind", "sourceInstanceId"])
    && boundedString(value.sourceInstanceId, MAX_ID_LENGTH)
  ) {
    return { kind: "follow", sourceInstanceId: value.sourceInstanceId };
  }
  return null;
}

function parseDockNode(
  value: unknown,
  schemaVersion: LayoutMarketplaceSchemaVersion,
  depth = 0,
): DockLayoutNode | null | undefined {
  if (value === null) return null;
  if (depth > MAX_DOCK_DEPTH || !record(value) || !boundedString(value.kind, 16)) return undefined;
  if (
    value.kind === "pane"
    && exactKeys(value, ["kind", "instanceId"])
    && boundedString(value.instanceId, MAX_ID_LENGTH)
    && (schemaVersion === 1 || WIRE_ID.test(value.instanceId))
  ) {
    return { kind: "pane", instanceId: value.instanceId };
  }
  if (
    value.kind === "split"
    && exactKeys(value, ["kind", "axis", "ratio", "first", "second"])
    && (value.axis === "horizontal" || value.axis === "vertical")
    && boundedNumber(value.ratio, 0, 1)
  ) {
    const first = parseDockNode(value.first, schemaVersion, depth + 1);
    const second = parseDockNode(value.second, schemaVersion, depth + 1);
    if (!first || !second) return undefined;
    return {
      kind: "split",
      axis: value.axis,
      ratio: value.ratio,
      first,
      second,
    };
  }
  return undefined;
}

function collectDockedIds(node: DockLayoutNode | null, ids: string[]): boolean {
  if (!node) return true;
  if (node.kind === "pane") {
    if (ids.includes(node.instanceId)) return false;
    ids.push(node.instanceId);
    return true;
  }
  return collectDockedIds(node.first, ids) && collectDockedIds(node.second, ids);
}

function hasFollowCycle(instances: LayoutConfig["instances"]): boolean {
  const follows = new Map(instances.flatMap((instance) => (
    instance.binding?.kind === "follow"
      ? [[instance.instanceId, instance.binding.sourceInstanceId] as const]
      : []
  )));
  for (const start of follows.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current && follows.has(current)) {
      if (visited.has(current)) return true;
      visited.add(current);
      current = follows.get(current);
    }
  }
  return false;
}

function parseLayout(value: unknown, schemaVersion: LayoutMarketplaceSchemaVersion): LayoutConfig | null {
  if (!record(value) || !exactKeys(value, ["dockRoot", "instances", "floating", "detached"])) return null;
  if (!Array.isArray(value.instances) || value.instances.length === 0 || value.instances.length > MAX_INSTANCES) return null;
  if (!Array.isArray(value.floating) || !Array.isArray(value.detached)) return null;

  const dockRoot = parseDockNode(value.dockRoot, schemaVersion);
  if (dockRoot === undefined) return null;

  const instanceIds = new Set<string>();
  const instances: LayoutConfig["instances"] = [];
  for (const raw of value.instances) {
    const optional = schemaVersion === 1
      ? ["binding"]
      : ["title", "binding", "params", "settings"];
    if (
      !record(raw)
      || !exactKeys(raw, ["instanceId", "paneId"], optional)
      || !boundedString(raw.instanceId, MAX_ID_LENGTH)
      || (schemaVersion === 2 && !WIRE_ID.test(raw.instanceId))
      || !boundedString(raw.paneId, MAX_PANE_ID_LENGTH)
      || instanceIds.has(raw.instanceId)
    ) return null;
    const binding = raw.binding === undefined ? undefined : parseBinding(raw.binding);
    if (raw.binding !== undefined && !binding) return null;
    const title = raw.title === undefined ? undefined : raw.title;
    if (title !== undefined && (!boundedString(title, MAX_TITLE_LENGTH) || title !== title.trim())) return null;
    const params = raw.params === undefined ? undefined : parseRecord(raw.params);
    if (raw.params !== undefined && (!params || Object.values(params).some((entry) => typeof entry !== "string"))) return null;
    const settings = raw.settings === undefined ? undefined : parseRecord(raw.settings);
    if (raw.settings !== undefined && !settings) return null;
    instanceIds.add(raw.instanceId);
    instances.push({
      instanceId: raw.instanceId,
      paneId: raw.paneId,
      ...(typeof title === "string" ? { title } : {}),
      ...(binding ? { binding } : {}),
      ...(params ? { params: params as Record<string, string> } : {}),
      ...(settings ? { settings } : {}),
    });
  }

  const parsePlacement = (
    raw: unknown,
    detached: boolean,
  ): LayoutConfig["floating"][number] | LayoutConfig["detached"][number] | null => {
    if (!record(raw)) return null;
    const optional = detached ? [] : ["zIndex"];
    if (!exactKeys(raw, ["instanceId", "x", "y", "width", "height"], optional)) return null;
    if (
      !boundedString(raw.instanceId, MAX_ID_LENGTH)
      || (schemaVersion === 2 && !WIRE_ID.test(raw.instanceId))
      || !boundedNumber(raw.x, 0, MAX_COORDINATE)
      || !boundedNumber(raw.y, 0, MAX_COORDINATE)
      || !boundedNumber(raw.width, 1, MAX_COORDINATE)
      || !boundedNumber(raw.height, 1, MAX_COORDINATE)
    ) return null;
    if (!detached && raw.zIndex !== undefined && !boundedNumber(raw.zIndex, -MAX_COORDINATE, MAX_COORDINATE)) return null;
    return {
      instanceId: raw.instanceId,
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      width: Math.round(raw.width),
      height: Math.round(raw.height),
      ...(!detached && typeof raw.zIndex === "number" ? { zIndex: Math.round(raw.zIndex) } : {}),
    };
  };

  const floating: LayoutConfig["floating"] = [];
  for (const raw of value.floating) {
    const placement = parsePlacement(raw, false);
    if (!placement) return null;
    floating.push(placement);
  }
  const detached: LayoutConfig["detached"] = [];
  for (const raw of value.detached) {
    const placement = parsePlacement(raw, true);
    if (!placement) return null;
    detached.push(placement);
  }

  const dockedIds: string[] = [];
  if (!collectDockedIds(dockRoot, dockedIds)) return null;
  const placedIds = [...dockedIds, ...floating.map((entry) => entry.instanceId), ...detached.map((entry) => entry.instanceId)];
  if (new Set(placedIds).size !== placedIds.length) return null;
  if (placedIds.some((id) => !instanceIds.has(id)) || placedIds.length !== instanceIds.size) return null;
  for (const instance of instances) {
    if (instance.binding?.kind === "follow" && !instanceIds.has(instance.binding.sourceInstanceId)) return null;
  }
  if (hasFollowCycle(instances)) return null;

  return { dockRoot, instances, floating, detached };
}

function parsePaneState(
  value: unknown,
  instanceIds: Set<string>,
): Record<string, PaneRuntimeState> | null {
  if (!record(value) || Object.keys(value).some((id) => !instanceIds.has(id))) return null;
  const parsed: Record<string, PaneRuntimeState> = {};
  for (const [id, state] of Object.entries(value)) {
    const next = parseRecord(state);
    if (!next) return null;
    parsed[id] = next as PaneRuntimeState;
  }
  return parsed;
}

export function parseMarketplaceLayoutPayload(value: unknown): LayoutMarketplacePayload | null {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return null;
  const schemaVersion = value.schemaVersion;
  const required = schemaVersion === 2
    ? ["schemaVersion", "sourceConfigVersion", "layout", "paneState"]
    : ["schemaVersion", "sourceConfigVersion", "layout"];
  if (
    !exactKeys(value, required)
    || !Number.isSafeInteger(value.sourceConfigVersion)
    || (value.sourceConfigVersion as number) < 1
    || encodedSize(value) > MAX_LAYOUT_BYTES
  ) return null;
  const layout = parseLayout(value.layout, schemaVersion);
  if (!layout) return null;
  const paneState = schemaVersion === 2
    ? parsePaneState(value.paneState, new Set(layout.instances.map((instance) => instance.instanceId)))
    : {};
  return paneState
    ? {
        schemaVersion,
        sourceConfigVersion: value.sourceConfigVersion as number,
        layout,
        paneState,
      }
    : null;
}

function mapDockNode(node: DockLayoutNode | null, ids: ReadonlyMap<string, string>): DockLayoutNode | null {
  if (!node) return null;
  if (node.kind === "pane") return { kind: "pane", instanceId: ids.get(node.instanceId) ?? node.instanceId };
  return {
    ...node,
    first: mapDockNode(node.first, ids)!,
    second: mapDockNode(node.second, ids)!,
  };
}

function mapBinding(binding: PaneBinding | undefined, ids: ReadonlyMap<string, string>): PaneBinding | undefined {
  return binding?.kind === "follow"
    ? { kind: "follow", sourceInstanceId: ids.get(binding.sourceInstanceId) ?? binding.sourceInstanceId }
    : binding ? structuredClone(binding) : undefined;
}

function publishableLayout(
  publicLayout: LayoutConfig,
  paneState: Record<string, PaneRuntimeState>,
  panes: ReadonlyMap<string, PaneDef>,
): LayoutMarketplacePayload {
  const ids = new Map(publicLayout.instances.map((instance, index) => [instance.instanceId, `p${index + 1}`]));
  const projectedState: Record<string, PaneRuntimeState> = {};
  const instances = publicLayout.instances.map((instance) => {
    const instanceId = ids.get(instance.instanceId)!;
    const def = panes.get(instance.paneId);
    const privacy = def?.portableShare?.private;
    const params = def ? sanitizeRecord(instance.params, privacy?.params) : undefined;
    const settings = def ? sanitizeRecord(instance.settings, privacy?.settings) : undefined;
    const state = def ? sanitizeRecord(paneState[instance.instanceId], privacy?.state) : undefined;
    if (state) projectedState[instanceId] = state as PaneRuntimeState;
    const title = def && !privacy?.title ? instance.title?.trim() : undefined;
    return {
      instanceId,
      paneId: instance.paneId,
      ...(title ? { title } : {}),
      ...(instance.binding ? { binding: mapBinding(instance.binding, ids) } : {}),
      ...(params ? { params: params as Record<string, string> } : {}),
      ...(settings ? { settings } : {}),
    };
  });
  const projected: LayoutConfig = {
    dockRoot: mapDockNode(publicLayout.dockRoot, ids),
    instances,
    floating: publicLayout.floating.map(({ instanceId, x, y, width, height, zIndex }) => ({
      instanceId: ids.get(instanceId) ?? instanceId,
      x,
      y,
      width,
      height,
      ...(zIndex === undefined ? {} : { zIndex }),
    })),
    detached: publicLayout.detached.map(({ instanceId, x, y, width, height }) => ({
      instanceId: ids.get(instanceId) ?? instanceId,
      x,
      y,
      width,
      height,
    })),
  };
  const parsed = parseMarketplaceLayoutPayload({
    schemaVersion: 2,
    sourceConfigVersion: CURRENT_CONFIG_VERSION,
    layout: projected,
    paneState: projectedState,
  });
  if (!parsed) throw new Error("This layout cannot be published safely.");
  return parsed;
}

export function publishableMarketplaceLayout(
  layout: LayoutConfig,
  paneState: Record<string, PaneRuntimeState>,
  panes: ReadonlyMap<string, PaneDef>,
): LayoutMarketplacePayload {
  return publishableLayout(removePaneInstances(
    layout,
    layout.instances
      .filter((instance) => instance.paneId === "layout-marketplace")
      .map((instance) => instance.instanceId),
  ), paneState, panes);
}

export function publishableMarketplacePane(
  pane: LayoutConfig["instances"][number],
  paneState: PaneRuntimeState,
  panes: ReadonlyMap<string, PaneDef>,
  resolvedTicker?: string | null,
): LayoutMarketplacePayload {
  const def = panes.get(pane.paneId);
  if (!def) throw new Error("This pane is unavailable.");
  const binding = pane.binding?.kind === "follow"
    ? resolvedTicker?.trim()
      ? { kind: "fixed" as const, symbol: resolvedTicker.trim() }
      : { kind: "none" as const }
    : pane.binding;
  const size = def.defaultFloatingSize ?? { width: 80, height: 24 };
  return publishableLayout({
    dockRoot: null,
    instances: [{ ...pane, ...(binding ? { binding } : {}) }],
    floating: [{
      instanceId: pane.instanceId,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
    }],
    detached: [],
  }, { [pane.instanceId]: paneState }, panes);
}

export function materializeMarketplaceLayout(
  payload: Pick<LayoutMarketplacePayload, "layout" | "paneState">,
  createId: (paneId: string, index: number) => string = (paneId) => (
    `${paneId.slice(0, 80)}:shared-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  ),
): { layout: LayoutConfig; paneState: Record<string, PaneRuntimeState> } {
  const ids = new Map(payload.layout.instances.map((instance, index) => [
    instance.instanceId,
    createId(instance.paneId, index),
  ]));
  if (new Set(ids.values()).size !== ids.size) throw new Error("Could not create unique pane ids for this layout.");
  const layout: LayoutConfig = {
    dockRoot: mapDockNode(payload.layout.dockRoot, ids),
    instances: payload.layout.instances.map((instance) => ({
      ...structuredClone(instance),
      instanceId: ids.get(instance.instanceId)!,
      ...(instance.binding ? { binding: mapBinding(instance.binding, ids) } : {}),
    })),
    floating: payload.layout.floating.map((entry) => ({
      ...entry,
      instanceId: ids.get(entry.instanceId) ?? entry.instanceId,
    })),
    detached: payload.layout.detached.map((entry) => ({
      ...entry,
      instanceId: ids.get(entry.instanceId) ?? entry.instanceId,
    })),
  };
  const paneState = Object.fromEntries(Object.entries(payload.paneState).flatMap(([id, state]) => {
    const materializedId = ids.get(id);
    return materializedId ? [[materializedId, structuredClone(state)]] : [];
  }));
  return { layout, paneState };
}

export function parseMarketplaceLayoutEntry(value: unknown): LayoutMarketplaceEntry | null {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return null;
  const required = ["id", "name", "schemaVersion", "sourceConfigVersion", "layout", "author", "publishedAt"];
  const optional = value.schemaVersion === 2 ? ["paneState"] : [];
  if (
    !exactKeys(value, required, optional)
    || typeof value.id !== "string"
    || !MARKETPLACE_ID.test(value.id)
    || !boundedString(value.name, MAX_NAME_LENGTH)
    || !record(value.author)
    || !exactKeys(value.author, ["username", "displayName"])
    || !(value.author.username === null || boundedString(value.author.username, MAX_AUTHOR_LENGTH))
    || !boundedString(value.author.displayName, MAX_AUTHOR_LENGTH)
    || !boundedString(value.publishedAt, 64)
    || Number.isNaN(Date.parse(value.publishedAt))
  ) return null;
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
    ...payload,
    author: {
      username: value.author.username as string | null,
      displayName: value.author.displayName,
    },
    publishedAt: value.publishedAt,
  };
}

export function parseMarketplaceLayoutList(value: unknown): LayoutMarketplaceEntry[] | null {
  if (!record(value) || !exactKeys(value, ["items"]) || !Array.isArray(value.items) || value.items.length > 50) return null;
  const items = value.items.map(parseMarketplaceLayoutEntry);
  return items.every((item): item is LayoutMarketplaceEntry => item !== null) ? items : null;
}

export function isMarketplaceLayoutId(value: string): boolean {
  return MARKETPLACE_ID.test(value);
}
