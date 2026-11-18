import type { AppResourceStorePort } from "../core/app-service-ports";
import { logFailure } from "../utils/log-failure";
import { WARM_RESOURCE_BUDGET } from "./durable-resources";
import { packJson, unpackJson } from "./packed-json";

/**
 * What a pane last loaded, kept so the next launch opens on it at once and
 * refreshes behind it, on every renderer: the terminal keeps it in its cache
 * database, the desktop view and the web app in their durable stores
 * (data/durable-resources.ts).
 *
 * A copy is filed under the key its loader names: everything the answer
 * depends on (`["analyst", symbol, exchange]`), so a pane never opens on a
 * copy of something it no longer asks for, and a schema version, so a copy
 * of an older shape is dropped rather than drawn. The data hooks take it as
 * `savedCopy` (react/async-resource.ts, components/paged-rows.ts).
 *
 * Values keep their dates, maps and sets; a value holding anything else that
 * is not plain data (a function, a class instance) is not saved.
 */
export interface SavedCopyKey {
  /** Everything the loaded value depends on. */
  key: readonly unknown[];
  /** Raised when the value's shape changes, so older copies are dropped. */
  version?: number;
}

export interface SavedCopy<T> {
  value: T;
  /** When the copy was loaded (ms). */
  fetchedAt: number;
}

const NAMESPACE = "pane:saved-copies";
const KIND = "loaded";
/** Kept until the cache evicts it: a copy of any age is shown, marked with its age, while it refreshes. */
const RETAIN_UNTIL = Number.MAX_SAFE_INTEGER;

let store: AppResourceStorePort | null = null;
let savedCopyFrame: (() => Promise<void>) | null = null;

/** Host wiring: the app's resource store, or null when the app closes. */
export function setSavedCopyStore(next: AppResourceStorePort | null): AppResourceStorePort | null {
  const previous = store;
  store = next;
  return previous;
}

/** Lets a renderer paint its first saved result before starting the refresh. */
export function setSavedCopyFrameGate(gate: (() => Promise<void>) | null): void {
  savedCopyFrame = gate;
}

export function afterSavedCopyFrame(): Promise<void> | undefined {
  return savedCopyFrame?.();
}

export function savedCopyId(key: SavedCopyKey): string {
  return JSON.stringify(key.key);
}

function resourceKey(id: string) {
  return { namespace: NAMESPACE, kind: KIND, entityKey: id };
}

const MARK = "__gloomSaved";
type Encoded = { [MARK]: "date" | "map" | "set" | "number" | "ref" | "object"; value: unknown };

class NotPlainData extends Error {}

function encodeObject(value: object, encode: (value: unknown) => unknown): unknown {
  if (value instanceof Date) return { [MARK]: "date", value: value.getTime() } satisfies Encoded;
  if (value instanceof Map) return { [MARK]: "map", value: [...value].map(([key, entry]) => [encode(key), encode(entry)]) } satisfies Encoded;
  if (value instanceof Set) return { [MARK]: "set", value: [...value].map(encode) } satisfies Encoded;
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : encode(entry));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new NotPlainData();
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, encode(entry)]);
  return Object.hasOwn(value, MARK) ? { [MARK]: "object", value: entries } satisfies Encoded : Object.fromEntries(entries);
}

function encodeSnapshot(value: unknown): unknown {
  const references = new Map<object, number>();
  const encode = (entry: unknown): unknown => {
    if (entry == null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : { [MARK]: "number", value: String(entry) } satisfies Encoded;
    if (typeof entry !== "object") throw new NotPlainData();
    const ref = references.get(entry);
    if (ref != null) {
      if (ref < 0) throw new NotPlainData();
      return { [MARK]: "ref", value: ref } satisfies Encoded;
    }
    const ordinal = references.size;
    references.set(entry, -1);
    const encoded = encodeObject(entry, encode);
    references.set(entry, ordinal);
    return encoded;
  };
  return encode(value);
}

function decodeObject(value: object, decode: (value: unknown) => unknown): unknown {
  const record = value as Record<string, unknown>;
  switch (record[MARK]) {
    case "date": return new Date(record.value as number);
    case "map": return new Map((record.value as Array<[unknown, unknown]>).map(([key, entry]) => [decode(key), decode(entry)]));
    case "set": return new Set((record.value as unknown[]).map(decode));
    case "object": return Object.fromEntries((record.value as Array<[string, unknown]>).map(([key, entry]) => [key, decode(entry)]));
    default:
      for (const key of Object.keys(record)) record[key] = decode(record[key]);
      return record;
  }
}

function decodeSnapshot(value: unknown): unknown {
  const references: unknown[] = [];
  const decode = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;
    if (Object.hasOwn(entry, MARK)) {
      const marked = entry as Encoded;
      if (marked[MARK] === "number") return Number(marked.value);
      if (marked[MARK] === "ref") {
        const index = marked.value;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= references.length) throw new NotPlainData();
        const reference = references[index];
        if (reference === undefined) throw new NotPlainData();
        return reference;
      }
    }
    const ordinal = references.length;
    references.push(undefined);
    return references[ordinal] = decodeObject(entry, decode);
  };
  return decode(value);
}

function unpackSnapshot(value: string): unknown {
  const json = unpackJson(value);
  const parsed: unknown = JSON.parse(json);
  return json.includes(`"${MARK}"`) ? decodeSnapshot(parsed) : parsed;
}

/** The copy saved under `key`, of any age; null when there is none, or it is of another version. */
export function readSavedCopy<T>(key: SavedCopyKey): SavedCopy<T> | null {
  if (!store) return null;
  try {
    const record = store.get<string>(resourceKey(savedCopyId(key)), { schemaVersion: key.version ?? 1, allowExpired: true });
    return record ? { value: unpackSnapshot(record.value) as T, fetchedAt: record.fetchedAt } : null;
  } catch (error) {
    logFailure("data.pane-saved-copies", "Reading a saved copy failed")(error);
    return null;
  }
}

export function hasSavedCopy(key: SavedCopyKey): boolean {
  try {
    return store?.get(resourceKey(savedCopyId(key)), { schemaVersion: key.version ?? 1, allowExpired: true, touch: false }) != null;
  } catch (error) {
    logFailure("data.pane-saved-copies", "Checking for a saved copy failed")(error);
    return false;
  }
}

/**
 * A copy saved again this soon after the last one for its key is skipped: a
 * pane that refreshes every few seconds does not rewrite its copy each time,
 * and the next launch opens on one at most this old.
 */
const lastWrites = new WeakMap<AppResourceStorePort, Map<string, number>>();

/** Saves `value` as the copy for `key`, loaded at `fetchedAt`. A value that is not plain data is not saved. */
export function writeSavedCopy(key: SavedCopyKey, value: unknown, fetchedAt = Date.now(), writeIntervalMs = 0): void {
  if (!store) return;
  if (value == null) { deleteSavedCopy(key); return; }
  const id = savedCopyId(key);
  const writes = writeIntervalMs > 0 ? lastWrites.get(store) ?? new Map<string, number>() : null;
  const last = writes?.get(id);
  const now = Date.now();
  if (last !== undefined && now - last >= 0 && now - last < writeIntervalMs) return;
  try {
    store.set(resourceKey(id), packJson(JSON.stringify(encodeSnapshot(value))), { schemaVersion: key.version ?? 1, cachePolicy: { staleMs: 0, expireMs: RETAIN_UNTIL - fetchedAt }, fetchedAt });
    if (writes) {
      writes.delete(id);
      writes.set(id, now);
      if (writes.size > WARM_RESOURCE_BUDGET.maxRows) writes.delete(writes.keys().next().value!);
      lastWrites.set(store, writes);
    }
  } catch (error) {
    if (error instanceof NotPlainData) return;
    logFailure("data.pane-saved-copies", "Saving a copy failed")(error);
  }
}

/** Drops the copy for `key`: what it showed may no longer be shown (access withdrawn). */
export function deleteSavedCopy(key: SavedCopyKey): void {
  if (!store) return;
  const id = savedCopyId(key);
  lastWrites.get(store)?.delete(id);
  try {
    store.delete(resourceKey(id));
  } catch (error) {
    logFailure("data.pane-saved-copies", "Dropping a saved copy failed")(error);
  }
}
