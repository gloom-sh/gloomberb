import {
  CURRENT_CONFIG_VERSION,
  type DockLayoutNode,
  type LayoutConfig,
  type PaneBinding,
} from "../types/config";

const MAX_LAYOUT_BYTES = 128 * 1024;
const MAX_INSTANCES = 40;
const MAX_DOCK_DEPTH = 20;
const MAX_ID_LENGTH = 160;
const MAX_PANE_ID_LENGTH = 120;
const MAX_SYMBOL_LENGTH = 64;
const MAX_NAME_LENGTH = 80;
const MAX_AUTHOR_LENGTH = 100;
const MAX_COORDINATE = 100_000;

export interface LayoutMarketplaceAuthor {
  username: string | null;
  displayName: string;
}

export interface LayoutMarketplacePayload {
  schemaVersion: 1;
  sourceConfigVersion: number;
  layout: LayoutConfig;
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

function parseDockNode(value: unknown, depth = 0): DockLayoutNode | null | undefined {
  if (value === null) return null;
  if (depth > MAX_DOCK_DEPTH || !record(value) || !boundedString(value.kind, 16)) return undefined;
  if (
    value.kind === "pane"
    && exactKeys(value, ["kind", "instanceId"])
    && boundedString(value.instanceId, MAX_ID_LENGTH)
  ) {
    return { kind: "pane", instanceId: value.instanceId };
  }
  if (
    value.kind === "split"
    && exactKeys(value, ["kind", "axis", "ratio", "first", "second"])
    && (value.axis === "horizontal" || value.axis === "vertical")
    && boundedNumber(value.ratio, 0, 1)
  ) {
    const first = parseDockNode(value.first, depth + 1);
    const second = parseDockNode(value.second, depth + 1);
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

function parseLayout(value: unknown): LayoutConfig | null {
  if (!record(value) || !exactKeys(value, ["dockRoot", "instances", "floating", "detached"])) return null;
  if (!Array.isArray(value.instances) || value.instances.length === 0 || value.instances.length > MAX_INSTANCES) return null;
  if (!Array.isArray(value.floating) || !Array.isArray(value.detached)) return null;

  const dockRoot = parseDockNode(value.dockRoot);
  if (dockRoot === undefined) return null;

  const instanceIds = new Set<string>();
  const instances: LayoutConfig["instances"] = [];
  for (const raw of value.instances) {
    if (
      !record(raw)
      || !exactKeys(raw, ["instanceId", "paneId"], ["binding"])
      || !boundedString(raw.instanceId, MAX_ID_LENGTH)
      || !boundedString(raw.paneId, MAX_PANE_ID_LENGTH)
      || instanceIds.has(raw.instanceId)
    ) return null;
    const binding = raw.binding === undefined ? undefined : parseBinding(raw.binding);
    if (raw.binding !== undefined && !binding) return null;
    instanceIds.add(raw.instanceId);
    instances.push({
      instanceId: raw.instanceId,
      paneId: raw.paneId,
      ...(binding ? { binding } : {}),
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

  return { dockRoot, instances, floating, detached };
}

function parsePayload(value: unknown): LayoutMarketplacePayload | null {
  if (
    !record(value)
    || !exactKeys(value, ["schemaVersion", "sourceConfigVersion", "layout"])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.sourceConfigVersion)
    || (value.sourceConfigVersion as number) < 1
    || encodedSize(value) > MAX_LAYOUT_BYTES
  ) return null;
  const layout = parseLayout(value.layout);
  return layout ? { schemaVersion: 1, sourceConfigVersion: value.sourceConfigVersion as number, layout } : null;
}

export function publishableMarketplaceLayout(layout: LayoutConfig): LayoutMarketplacePayload {
  const projected: LayoutConfig = {
    dockRoot: layout.dockRoot,
    instances: layout.instances.map((instance) => ({
      instanceId: instance.instanceId,
      paneId: instance.paneId,
      ...(instance.binding ? { binding: instance.binding } : {}),
    })),
    floating: layout.floating.map(({ instanceId, x, y, width, height, zIndex }) => ({
      instanceId,
      x,
      y,
      width,
      height,
      ...(zIndex === undefined ? {} : { zIndex }),
    })),
    detached: layout.detached.map(({ instanceId, x, y, width, height }) => ({ instanceId, x, y, width, height })),
  };
  const parsed = parsePayload({
    schemaVersion: 1,
    sourceConfigVersion: CURRENT_CONFIG_VERSION,
    layout: projected,
  });
  if (!parsed) throw new Error("This layout cannot be published safely.");
  return parsed;
}

export function parseMarketplaceLayoutEntry(value: unknown): LayoutMarketplaceEntry | null {
  if (
    !record(value)
    || !exactKeys(value, ["id", "name", "schemaVersion", "sourceConfigVersion", "layout", "author", "publishedAt"])
    || typeof value.id !== "string"
    || !/^[a-f0-9]{32}$/i.test(value.id)
    || !boundedString(value.name, MAX_NAME_LENGTH)
    || !record(value.author)
    || !exactKeys(value.author, ["username", "displayName"])
    || !(value.author.username === null || boundedString(value.author.username, MAX_AUTHOR_LENGTH))
    || !boundedString(value.author.displayName, MAX_AUTHOR_LENGTH)
    || !boundedString(value.publishedAt, 64)
    || Number.isNaN(Date.parse(value.publishedAt))
  ) return null;
  const payload = parsePayload({
    schemaVersion: value.schemaVersion,
    sourceConfigVersion: value.sourceConfigVersion,
    layout: value.layout,
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
