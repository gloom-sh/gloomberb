import type { AppResourceStorePort } from "../core/app-service-ports";
import { logFailure } from "../utils/log-failure";
import { WARM_RESOURCE_BUDGET } from "./durable-resources";

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

/** Host wiring: the app's resource store, or null when the app closes. */
export function setSavedCopyStore(next: AppResourceStorePort | null): AppResourceStorePort | null {
  const previous = store;
  store = next;
  return previous;
}

export function savedCopyId(key: SavedCopyKey): string {
  return JSON.stringify(key.key);
}

function resourceKey(id: string) {
  return { namespace: NAMESPACE, kind: KIND, entityKey: id };
}

const MARK = "__gloomSaved";
type Encoded = { [MARK]: "date" | "map" | "set" | "number"; value: unknown };

class NotPlainData extends Error {}

function encode(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { [MARK]: "number", value: String(value) } satisfies Encoded;
  if (value === undefined) return undefined;
  if (value instanceof Date) return { [MARK]: "date", value: value.getTime() } satisfies Encoded;
  if (value instanceof Map) return { [MARK]: "map", value: [...value].map(([key, entry]) => [encode(key), encode(entry)]) } satisfies Encoded;
  if (value instanceof Set) return { [MARK]: "set", value: [...value].map(encode) } satisfies Encoded;
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : encode(entry));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new NotPlainData();
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, encode(entry)]);
    return Object.hasOwn(value, MARK) ? { [MARK]: "object", value: entries } : Object.fromEntries(entries);
  }
  throw new NotPlainData();
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  switch (record[MARK]) {
    case "date": return new Date(record.value as number);
    case "map": return new Map((record.value as Array<[unknown, unknown]>).map(([key, entry]) => [decode(key), decode(entry)]));
    case "set": return new Set((record.value as unknown[]).map(decode));
    case "number": return Number(record.value);
    case "object": return Object.fromEntries((record.value as Array<[string, unknown]>).map(([key, entry]) => [key, decode(entry)]));
    default: return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decode(entry)]));
  }
}

/** The copy saved under `key`, of any age; null when there is none, or it is of another version. */
export function readSavedCopy<T>(key: SavedCopyKey): SavedCopy<T> | null {
  if (!store) return null;
  try {
    const record = store.get<unknown>(resourceKey(savedCopyId(key)), { schemaVersion: key.version ?? 1, allowExpired: true });
    return record ? { value: decode(record.value) as T, fetchedAt: record.fetchedAt } : null;
  } catch (error) {
    logFailure("data.pane-saved-copies", "Reading a saved copy failed")(error);
    return null;
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
    store.set(resourceKey(id), encode(value), { schemaVersion: key.version ?? 1, cachePolicy: { staleMs: 0, expireMs: RETAIN_UNTIL - fetchedAt }, fetchedAt });
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
