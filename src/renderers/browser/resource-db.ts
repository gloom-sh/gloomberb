import {
  createBatchedResourceSink,
  selectWarmRecords,
  WARM_RESOURCE_BUDGET,
  type BatchedResourceSink,
  type ResourceSyncBatch,
} from "../../data/durable-resources";
import { packWarmResource, resourceRecordKey, type WarmResourceRecord } from "../../data/memory-resource-store";
import { logFailure } from "../../utils/log-failure";
import { proResourceAccounts, type ProResourceAccess } from "../../data/pro-resource-access";

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
const DB_VERSION = 2;
const RECORDS = "records";
const META = "meta";
const PRO_CANDIDATES = "pro-candidates";
/** A launch waits this long at most for its saved copies before it draws without them. */
const OPEN_TIMEOUT_MS = 1_500;

interface RecordMeta { at: number; size: number; pro?: string[] }

function unpackKey(key: string) {
  const [namespace = "", kind = "", entityKey = "", , sourceKey] = key.split("\u0000");
  return { namespace, kind, entityKey, sourceKey };
}

export interface BrowserResources {
  records: WarmResourceRecord[];
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
    req.onupgradeneeded = ({ oldVersion }) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      const meta = oldVersion === 0 ? db.createObjectStore(META) : req.transaction!.objectStore(META);
      meta.createIndex(PRO_CANDIDATES, "pro", { multiEntry: true });
      if (oldVersion === 1) {
        const walking = meta.openCursor();
        walking.onsuccess = () => {
          const cursor = walking.result;
          if (!cursor) return;
          const pro = proResourceAccounts(unpackKey(String(cursor.primaryKey)));
          if (pro.length) cursor.update({ ...cursor.value, pro });
          cursor.continue();
        };
      }
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

function sizeOf(record: WarmResourceRecord): number {
  if (!("valueJson" in record)) return encoder.encode(JSON.stringify(record)).byteLength;
  const { valueJson, ...metadata } = record;
  return encoder.encode(valueJson).byteLength + encoder.encode(JSON.stringify(metadata)).byteLength + '"value":,'.length;
}

async function readMetadata(store: IDBObjectStore): Promise<Map<string, RecordMeta>> {
  const [keys, metas] = await Promise.all([request(store.getAllKeys()), request(store.getAll() as IDBRequest<RecordMeta[]>)]);
  return new Map(keys.map((key, index) => [String(key), metas[index]!]));
}

function withinBudget(entries: Map<string, RecordMeta>): Set<string> {
  const byAccess = [...entries].map(([key, { at, size }]) => ({ key, lastAccessedAt: at, size }));
  return new Set(selectWarmRecords(byAccess, (entry) => entry.size).map((entry) => entry.key));
}

async function readWarm(db: IDBDatabase): Promise<WarmResourceRecord[]> {
  const transaction = db.transaction([RECORDS, META], "readonly");
  const records = transaction.objectStore(RECORDS);
  const entries = await readMetadata(transaction.objectStore(META));
  const loaded = await Promise.all([...withinBudget(entries)].map(async (key) => {
    const record = await request(records.get(key) as IDBRequest<WarmResourceRecord | undefined>);
    return record ? { ...record, lastAccessedAt: entries.get(key)!.at } : null;
  }));
  return loaded.filter((record): record is WarmResourceRecord => record !== null);
}

async function writeBatch(db: IDBDatabase, batch: ResourceSyncBatch, access: ProResourceAccess): Promise<void> {
  const revoked = batch.proAccess?.filter(({ account }) => access.revokedMatcher(account)) ?? [];
  if (!revoked.length && !batch.set.length && !batch.delete.length && !batch.touch.length) return;
  const transaction = db.transaction([RECORDS, META], "readwrite");
  const records = transaction.objectStore(RECORDS);
  const meta = transaction.objectStore(META);
  if (revoked.length) {
    const candidates = await Promise.all(revoked.map(async ({ account }) => ({
      account, keys: await request(meta.index(PRO_CANDIDATES).getAllKeys(account)),
    })));
    for (const { account, keys } of candidates) {
      if (!access.revokedMatcher(account)) continue;
      for (const key of keys) {
        records.delete(key);
        meta.delete(key);
      }
    }
  }
  if (!batch.set.length && !batch.delete.length && !batch.touch.length) return done(transaction);
  const existing = await readMetadata(meta);
  const updates = new Map<string, WarmResourceRecord>();
  for (const record of batch.set) {
    if (!access.permits(record)) continue;
    const key = resourceRecordKey(record);
    const packed = packWarmResource(record);
    const size = sizeOf(packed);
    if (size > WARM_RESOURCE_BUDGET.maxBytes) continue;
    updates.set(key, packed);
    const pro = proResourceAccounts(record);
    existing.set(key, { at: record.lastAccessedAt, size, pro: pro.length ? pro : undefined });
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
    const records = await Promise.race([readWarm(connection), new Promise<WarmResourceRecord[]>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Reading the saved data timed out")), OPEN_TIMEOUT_MS);
    })]).finally(() => clearTimeout(timeout));
    return { records, sink: createBatchedResourceSink((batch, access) => closed ? undefined : writeBatch(connection, batch, access), { label: "browser-resources" }) };
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
