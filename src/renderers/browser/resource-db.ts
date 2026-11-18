import {
  createBatchedResourceSink,
  selectWarmRecords,
  WARM_RESOURCE_BUDGET,
  type BatchedResourceSink,
  type ResourceSyncBatch,
} from "../../data/durable-resources";
import { resourceRecordKey } from "../../data/memory-resource-store";
import type { CachedResourceRecord } from "../../data/resource-store";
import { logFailure } from "../../utils/log-failure";

/**
 * The web app's saved copies, in the browser's IndexedDB: every cached
 * resource the page writes (its plugins' caches and its market data), so a
 * reload opens its panes on them as the terminal opens on its cache database.
 * `records` keeps each record as saved; `meta` keeps its last read and size,
 * small enough to read whole when choosing what a launch starts from and
 * what goes. Writes stay within the warm-start budget by dropping the least
 * recently read records.
 */
const DB_NAME = "gloomberb-cache";
const DB_VERSION = 1;
const RECORDS = "records";
const META = "meta";
/** A launch waits this long at most for its saved copies before it draws without them. */
const OPEN_TIMEOUT_MS = 1_500;

interface RecordMeta { at: number; size: number }

export interface BrowserResources {
  records: CachedResourceRecord[];
  sink: BatchedResourceSink;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error("Opening the saved data timed out"));
    }, OPEN_TIMEOUT_MS);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      clearTimeout(timeout);
      if (timedOut) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => { clearTimeout(timeout); reject(req.error); };
  });
}

const encoder = new TextEncoder();

function sizeOf(record: CachedResourceRecord): number {
  return encoder.encode(JSON.stringify(record)).byteLength;
}

async function readMetadata(store: IDBObjectStore): Promise<Map<string, RecordMeta>> {
  const [keys, metas] = await Promise.all([request(store.getAllKeys()), request(store.getAll() as IDBRequest<RecordMeta[]>)]);
  return new Map(keys.map((key, index) => [String(key), metas[index]!]));
}

function withinBudget(entries: Map<string, RecordMeta>): Set<string> {
  const byAccess = [...entries].map(([key, { at, size }]) => ({ key, lastAccessedAt: at, size }));
  return new Set(selectWarmRecords(byAccess, (entry) => entry.size).map((entry) => entry.key));
}

async function readWarm(db: IDBDatabase): Promise<CachedResourceRecord[]> {
  const transaction = db.transaction([RECORDS, META], "readonly");
  const records = transaction.objectStore(RECORDS);
  const entries = await readMetadata(transaction.objectStore(META));
  const loaded = await Promise.all([...withinBudget(entries)].map(async (key) => {
    const record = await request(records.get(key) as IDBRequest<CachedResourceRecord | undefined>);
    return record ? { ...record, lastAccessedAt: entries.get(key)!.at } : null;
  }));
  return loaded.filter((record): record is CachedResourceRecord => record !== null);
}

async function writeBatch(db: IDBDatabase, batch: ResourceSyncBatch): Promise<void> {
  const transaction = db.transaction([RECORDS, META], "readwrite");
  const records = transaction.objectStore(RECORDS);
  const meta = transaction.objectStore(META);
  const existing = await readMetadata(meta);
  const updates = new Map<string, CachedResourceRecord>();
  for (const record of batch.set) {
    const key = resourceRecordKey(record);
    const size = sizeOf(record);
    if (size > WARM_RESOURCE_BUDGET.maxBytes) continue;
    updates.set(key, record);
    existing.set(key, { at: record.lastAccessedAt, size });
  }
  for (const key of batch.delete) {
    records.delete(resourceRecordKey(key));
    meta.delete(resourceRecordKey(key));
    existing.delete(resourceRecordKey(key));
  }
  for (const touch of batch.touch) {
    const key = resourceRecordKey(touch);
    const entry = existing.get(key);
    if (entry) entry.at = Math.max(entry.at, touch.at);
  }
  const keep = withinBudget(existing);
  for (const key of existing.keys()) {
    if (!keep.has(key)) {
      records.delete(key);
      meta.delete(key);
    } else if (updates.has(key)) {
      records.put(updates.get(key)!, key);
      meta.put(existing.get(key)!, key);
    }
  }
  for (const touch of batch.touch) {
    const key = resourceRecordKey(touch);
    if (keep.has(key)) meta.put(existing.get(key)!, key);
  }
  await done(transaction);
}

/**
 * Opens the saved copies a launch starts from, and the sink the page writes
 * through. Without IndexedDB (a private window that refuses it, a test), or
 * when it does not answer within `OPEN_TIMEOUT_MS`, the page starts from
 * nothing and keeps what it fetches for the session only.
 */
export async function openBrowserResources(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<BrowserResources | undefined> {
  if (!factory) return undefined;
  let db: IDBDatabase | undefined;
  try {
    const connection = db = await open(factory);
    let closed = false;
    connection.onversionchange = () => { closed = true; connection.close(); };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const records = await Promise.race([readWarm(connection), new Promise<CachedResourceRecord[]>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Reading the saved data timed out")), OPEN_TIMEOUT_MS);
    })]).finally(() => clearTimeout(timeout));
    return { records, sink: createBatchedResourceSink((batch) => closed ? undefined : writeBatch(connection, batch), { label: "browser-resources" }) };
  } catch (error) {
    db?.close();
    logFailure("browser-resources", "Could not open the saved data")(error);
    return undefined;
  }
}

export async function resetBrowserResources(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!factory) return;
  const deletion = factory.deleteDatabase(DB_NAME);
  await Promise.race([request(deletion), new Promise<never>((_, reject) => {
    deletion.onblocked = () => reject(new Error("Another tab is keeping the saved data open"));
  })]);
}
