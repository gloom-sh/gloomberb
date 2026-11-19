import type { ResourceRecordSink } from "./memory-resource-store";
import { resourceRecordKey, WARM_RESOURCE_BUDGET } from "./memory-resource-store";
import type { CachedResourceRecord, ResourceCacheKey } from "./resource-store";
import { logFailure } from "../utils/log-failure";
import { createPersistScheduler } from "../state/persist-scheduler";
import { ProResourceAccess } from "./pro-resource-access";

export { WARM_RESOURCE_BUDGET };

/** One write to a durable store: what changed since the last, newest wins per record. */
export interface ResourceSyncBatch {
  set: CachedResourceRecord[];
  delete: ResourceCacheKey[];
  touch: Array<ResourceCacheKey & { at: number }>;
  proAccess?: Array<{ account: string; allowed: boolean }>;
}

export interface BatchedResourceSink extends ResourceRecordSink {
  /** Writes what is pending now, and resolves when that write has settled. */
  flush(): Promise<void>;
}

function keyOf({ namespace, kind, entityKey, variantKey, sourceKey }: ResourceCacheKey): ResourceCacheKey {
  return { namespace, kind, entityKey, variantKey: variantKey ?? "", sourceKey: sourceKey ?? "" };
}

/**
 * A sink that gathers changes and hands them to `write` together: the first
 * change arms one write `delayMs` later (later ones do not push it back), a
 * refresh that saves twenty records makes one write, and a record saved twice
 * in that time is written once. Writes run one at a time, in order, and join
 * the app's pending persistence, so a quit or a hidden page drains them
 * (`flushPendingPersistence`). A write that fails is logged and its changes
 * dropped: the next launch fetches those again.
 */
export function createBatchedResourceSink(
  write: (batch: ResourceSyncBatch, access: ProResourceAccess) => Promise<unknown> | unknown,
  { delayMs = 500, label = "data.durable-resources" }: { delayMs?: number; label?: string } = {},
): BatchedResourceSink {
  const changes = new Map<string, { record: CachedResourceRecord } | { deleted: ResourceCacheKey }>();
  const touches = new Map<string, ResourceCacheKey & { at: number }>();
  const access = new ProResourceAccess();
  const accessChanges = new Map<string, boolean>();
  let armed = false;
  const writes = createPersistScheduler<void>({
    delayMs,
    save: async () => {
      armed = false;
      if (changes.size === 0 && touches.size === 0 && accessChanges.size === 0) return;
      const batch: ResourceSyncBatch = { set: [], delete: [], touch: [...touches.values()] };
      if (accessChanges.size) batch.proAccess = [...accessChanges].map(([account, allowed]) => ({ account, allowed }));
      for (const change of changes.values()) {
        if ("record" in change) batch.set.push(change.record);
        else batch.delete.push(change.deleted);
      }
      changes.clear();
      touches.clear();
      accessChanges.clear();
      await write(batch, access);
    },
    onError: logFailure(label, "Could not save cached resources"),
  });
  const arm = () => {
    if (armed) return;
    armed = true;
    writes.schedule();
  };

  return {
    set(record) {
      const id = resourceRecordKey(record);
      changes.set(id, { record });
      touches.delete(id);
      arm();
    },
    delete(key) {
      const id = resourceRecordKey(key);
      changes.set(id, { deleted: keyOf(key) });
      touches.delete(id);
      arm();
    },
    setProResourceAccess(account, allowed) {
      if (!access.update(account, allowed)) return;
      accessChanges.set(account, allowed);
      const matches = access.revokedMatcher(account);
      if (matches) {
        for (const [id, change] of changes) if ("record" in change && matches(change.record)) changes.delete(id);
        for (const [id, touch] of touches) if (matches(touch)) touches.delete(id);
      }
      armed = true;
      writes.schedule(undefined, 0);
    },
    touch(key, at) {
      const id = resourceRecordKey(key);
      if (changes.has(id)) return;
      touches.set(id, { ...keyOf(key), at });
      arm();
    },
    flush: () => writes.flush(),
  };
}

/**
 * The records a launch starts from: the most recently read first, while they
 * fit the budget. `sizeOf` measures a record the way its store counts it.
 */
export function selectWarmRecords<R extends Pick<CachedResourceRecord, "lastAccessedAt">>(
  records: readonly R[],
  sizeOf: (record: R) => number,
  budget: { maxBytes: number; maxRows: number } = WARM_RESOURCE_BUDGET,
): R[] {
  const kept: R[] = [];
  let bytes = 0;
  for (const record of [...records].sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)) {
    if (kept.length >= budget.maxRows) break;
    const size = sizeOf(record);
    if (bytes + size > budget.maxBytes) continue;
    bytes += size;
    kept.push(record);
  }
  return kept;
}

/**
 * The namespaces the DOM renderers keep of their own: the plugins' caches and
 * account snapshots (`plugin:`) and the panes' saved copies (`pane:`). The
 * desktop view's market data lives in its Bun process, which keeps it there.
 */
export const VIEW_RESOURCE_NAMESPACES = ["plugin:", "pane:"] as const;

export function isViewResourceKey(key: Pick<ResourceCacheKey, "namespace">): boolean {
  return typeof key.namespace === "string" && VIEW_RESOURCE_NAMESPACES.some((prefix) => key.namespace.startsWith(prefix));
}

interface SyncTarget {
  set(key: ResourceCacheKey, value: unknown, options: { schemaVersion?: number; provenance?: CachedResourceRecord["provenance"]; fetchedAt?: number; cachePolicy: { staleMs: number; expireMs: number } }): unknown;
  delete(key: ResourceCacheKey): void;
  setProResourceAccess(account: string, allowed: boolean): void;
  touch?(key: ResourceCacheKey, at: number): void;
}

function isKey(value: unknown): value is ResourceCacheKey {
  const key = value as ResourceCacheKey | null;
  return !!key && typeof key.namespace === "string" && typeof key.kind === "string" && typeof key.entityKey === "string";
}

/**
 * Applies a batch a renderer sent (`createBatchedResourceSink`) to a store,
 * each record with its own times. Records `accept` refuses, or that are not
 * records, are skipped.
 */
export function applyResourceSync(store: SyncTarget, batch: Partial<ResourceSyncBatch> | null | undefined, accept: (key: ResourceCacheKey) => boolean = isViewResourceKey): void {
  for (const update of Array.isArray(batch?.proAccess) ? batch.proAccess : []) {
    if (update && typeof update.account === "string" && update.account && typeof update.allowed === "boolean") {
      store.setProResourceAccess(update.account, update.allowed);
    }
  }
  for (const record of Array.isArray(batch?.set) ? batch.set : []) {
    if (!isKey(record) || !accept(record) || ![record.fetchedAt, record.staleAt, record.expiresAt].every(Number.isFinite)) continue;
    store.set(record, record.value, {
      schemaVersion: record.schemaVersion,
      provenance: record.provenance,
      fetchedAt: record.fetchedAt,
      cachePolicy: { staleMs: record.staleAt - record.fetchedAt, expireMs: record.expiresAt - record.fetchedAt },
    });
  }
  for (const key of Array.isArray(batch?.delete) ? batch.delete : []) {
    if (isKey(key) && accept(key)) store.delete(key);
  }
  for (const touch of Array.isArray(batch?.touch) ? batch.touch : []) {
    if (isKey(touch) && accept(touch) && Number.isFinite(touch.at)) store.touch?.(touch, touch.at);
  }
}
