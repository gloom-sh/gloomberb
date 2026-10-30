import type { Database } from "bun:sqlite";
import type { CachePolicy, PersistedResourceValue } from "../types/persistence";
import type { JsonValue } from "./sqlite/json";
import { createSqliteAccess, type SqliteAccess } from "./sqlite/access";
import { safeParseJson, serializeJson } from "./sqlite/json";
import { logFailure } from "../utils/log-failure";

const RESOURCE_CACHE_SOFT_ROW_LIMIT = 25_000;
const RESOURCE_CACHE_SOFT_SIZE_LIMIT = 100 * 1024 * 1024;
const RESOURCE_CACHE_MAINTENANCE_WRITE_INTERVAL = 250;
const RESOURCE_CACHE_MAINTENANCE_BYTE_INTERVAL = Math.floor(
  RESOURCE_CACHE_SOFT_SIZE_LIMIT / RESOURCE_CACHE_MAINTENANCE_WRITE_INTERVAL,
);
const RESOURCE_CACHE_MAINTENANCE_TIME_INTERVAL_MS = 5 * 60_000;
/** Rows read per eviction pass, so a full cache is evicted in slices. */
const RESOURCE_CACHE_PRUNE_BATCH_SIZE = 512;
/**
 * A read moves its row up the eviction order in memory, and the rows read
 * since are written in one transaction this often, before an eviction and
 * at close: a read writes nothing. A crash loses at most this much of the
 * order, which only decides what is evicted first.
 */
const RESOURCE_CACHE_TOUCH_FLUSH_MS = 30_000;
const DEFAULT_RESOURCE_SCHEMA_VERSION = 1;
const EMPTY_VARIANT_KEY = "";
const EMPTY_SOURCE_KEY = "";

interface ResourceCacheRow {
  namespace: string;
  kind: string;
  entity_key: string;
  variant_key: string;
  source_key: string;
  schema_version: number;
  payload: string;
  provenance: string | null;
  fetched_at: number;
  stale_at: number;
  expires_at: number;
  last_accessed_at: number;
  size_bytes: number;
}

export interface ResourceCacheKey {
  namespace: string;
  kind: string;
  entityKey: string;
  variantKey?: string;
  sourceKey?: string;
}

export interface CachedResourceRecord<T = unknown> extends PersistedResourceValue<T> {
  namespace: string;
  kind: string;
  entityKey: string;
  variantKey: string;
  sourceKey: string;
  provenance: JsonValue | null;
  lastAccessedAt: number;
  sizeBytes: number;
}

export interface SetResourceOptions {
  schemaVersion?: number;
  cachePolicy: CachePolicy;
  provenance?: JsonValue | null;
  fetchedAt?: number;
}

export interface GetResourceOptions {
  schemaVersion?: number;
  allowExpired?: boolean;
  touch?: boolean;
  /**
   * A read refreshes a row's place in the eviction order, one write per row. A
   * row read many times a second (a quote, a price history) asks for it at most
   * once per this many ms, so it stays recent without a write on every read.
   * `touch: false` never refreshes it, and a row read that way looks old.
   */
  touchIntervalMs?: number;
}

export interface ListResourceOptions extends GetResourceOptions {
  variantKeys?: string[];
  sourceKeys?: string[];
}

function normalizeVariantKey(value: string | undefined): string {
  return value ?? EMPTY_VARIANT_KEY;
}

function normalizeSourceKey(value: string | undefined): string {
  return value ?? EMPTY_SOURCE_KEY;
}

function isExpired(expiresAt: number): boolean {
  return expiresAt < Date.now();
}

function isStale(staleAt: number): boolean {
  return staleAt < Date.now();
}

function rowMapKey(key: ResourceCacheKey): string {
  return [key.namespace, key.kind, key.entityKey, normalizeVariantKey(key.variantKey), normalizeSourceKey(key.sourceKey)].join("\u0000");
}

function sortRows(rows: ResourceCacheRow[]): ResourceCacheRow[] {
  return [...rows].sort((a, b) => {
    if (a.expires_at !== b.expires_at) return b.expires_at - a.expires_at;
    if (a.stale_at !== b.stale_at) return b.stale_at - a.stale_at;
    if (a.fetched_at !== b.fetched_at) return b.fetched_at - a.fetched_at;
    return b.last_accessed_at - a.last_accessed_at;
  });
}

export class ResourceStore {
  private writesSinceMaintenance = 0;
  private bytesWrittenSinceMaintenance = 0;
  private lastMaintenanceAt = 0;
  /** Reads not yet written to the eviction order, by row. */
  private readonly pendingTouches = new Map<string, { key: ResourceCacheKey; touchedAt: number }>();
  private touchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Everything here can be fetched again, so no statement waits for another
   * program's lock: a locked read is a miss, and a locked write is skipped.
   */
  constructor(
    private readonly db: Database,
    private readonly access: SqliteAccess = createSqliteAccess(db),
  ) {}

  private toCachedResource<T>(row: ResourceCacheRow): CachedResourceRecord<T> | null {
    const value = safeParseJson<T>(row.payload);
    if (value == null) return null;
    return {
      namespace: row.namespace,
      kind: row.kind,
      entityKey: row.entity_key,
      variantKey: row.variant_key,
      sourceKey: row.source_key,
      value,
      schemaVersion: row.schema_version,
      provenance: safeParseJson<JsonValue>(row.provenance),
      fetchedAt: row.fetched_at,
      staleAt: row.stale_at,
      expiresAt: row.expires_at,
      lastAccessedAt: row.last_accessed_at,
      sizeBytes: row.size_bytes,
      stale: isStale(row.stale_at),
      expired: isExpired(row.expires_at),
    };
  }

  private deleteExact(key: ResourceCacheKey): void {
    this.pendingTouches.delete(rowMapKey(key));
    this.access.writeCache("delete cached resource", () => {
      this.db
        .query(
          `DELETE FROM resource_cache
           WHERE namespace = ? AND kind = ? AND entity_key = ? AND variant_key = ? AND source_key = ?`,
        )
        .run(
          key.namespace,
          key.kind,
          key.entityKey,
          normalizeVariantKey(key.variantKey),
          normalizeSourceKey(key.sourceKey),
        );
    });
  }

  /** Moves a read row up the eviction order, unless it moved within `touchIntervalMs`. */
  private touchRead(record: CachedResourceRecord, options: GetResourceOptions): void {
    const mapKey = rowMapKey(record);
    record.lastAccessedAt = Math.max(record.lastAccessedAt, this.pendingTouches.get(mapKey)?.touchedAt ?? 0);
    if (options.touch === false) return;
    const now = Date.now();
    if (options.touchIntervalMs != null && now - record.lastAccessedAt < options.touchIntervalMs) return;
    const { namespace, kind, entityKey, variantKey, sourceKey } = record;
    this.pendingTouches.set(mapKey, { key: { namespace, kind, entityKey, variantKey, sourceKey }, touchedAt: now });
    record.lastAccessedAt = now;
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      try {
        this.flushTouches();
      } catch (error) {
        logFailure("data.resource-store", "Saving the cache's eviction order failed")(error);
      }
    }, RESOURCE_CACHE_TOUCH_FLUSH_MS);
    (this.touchTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Writes the reads since the last flush into the eviction order, in one
   * transaction. False when another program had the cache locked; they are
   * kept for the next one.
   */
  flushTouches(): boolean {
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
    if (this.pendingTouches.size === 0) return true;
    const touches = [...this.pendingTouches.values()];
    const written = this.access.writeCache("touch cached resources", () => {
      const update = this.db.query(
        `UPDATE resource_cache
         SET last_accessed_at = MAX(last_accessed_at, ?)
         WHERE namespace = ? AND kind = ? AND entity_key = ? AND variant_key = ? AND source_key = ?`,
      );
      this.db.transaction(() => {
        for (const { key, touchedAt } of touches) {
          update.run(
            touchedAt,
            key.namespace,
            key.kind,
            key.entityKey,
            normalizeVariantKey(key.variantKey),
            normalizeSourceKey(key.sourceKey),
          );
        }
      })();
    });
    if (written) this.pendingTouches.clear();
    return written;
  }

  /**
   * Writes the reads still held in memory; the connection closes after. A
   * failure loses only that order: the queued user writes and the
   * connection still have to close.
   */
  close(): void {
    try {
      this.flushTouches();
    } catch (error) {
      logFailure("data.resource-store", "Saving the cache's eviction order at close failed")(error);
    }
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
  }

  /** Null when another program has the cache locked; maintenance waits for the next write. */
  private readCacheFootprint(operationName: string): { count: number; totalSize: number } | null {
    const stats = this.access.readCache(operationName, () => (
      this.db
        .query<{ count: number; total_size: number }, []>(
          "SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM resource_cache",
        )
        .get()
    ));
    return stats ? { count: stats.count ?? 0, totalSize: stats.total_size ?? 0 } : null;
  }

  private withinSoftLimits(count: number, totalSize: number): boolean {
    return count <= RESOURCE_CACHE_SOFT_ROW_LIMIT && totalSize <= RESOURCE_CACHE_SOFT_SIZE_LIMIT;
  }

  /** False when another program had the cache locked and pruning has to try again later. */
  private pruneIfNeeded(): boolean {
    const footprint = this.readCacheFootprint("read resource cache size");
    if (!footprint) return false;
    if (this.withinSoftLimits(footprint.count, footprint.totalSize)) return true;

    const prunedExpired = this.access.writeCache("prune expired cached resources", () => {
      this.db.query("DELETE FROM resource_cache WHERE expires_at < ?").run(Date.now());
    });
    if (!prunedExpired) return false;

    const remaining = this.readCacheFootprint("read pruned resource cache size");
    if (!remaining) return false;
    let { count: remainingCount, totalSize: remainingSize } = remaining;
    if (this.withinSoftLimits(remainingCount, remainingSize)) return true;
    // Eviction goes by the order on disk, which has to hold the latest reads.
    if (!this.flushTouches()) return false;

    // Only the row ids, which the recency index holds: a row's size sits
    // after its payload, and reading it walks the whole payload from disk.
    // Asking it of the oldest 512 rows read 10 MB to pick what to evict.
    const candidates = this.db.query<{ rowid: number }, [number]>(
      `SELECT rowid
       FROM resource_cache
       ORDER BY last_accessed_at ASC, fetched_at ASC
       LIMIT ?`,
    );
    // Deleting a row reads its payload anyway, to free it: the size comes along.
    const remove = this.db.query<{ size_bytes: number }, [number]>(
      "DELETE FROM resource_cache WHERE rowid = ? RETURNING size_bytes",
    );

    // A cache at its limit holds tens of thousands of rows, so eviction reads
    // the oldest batch, deletes what the budget needs from it, and comes back
    // for more only if it is still over. Reading every row first turned the
    // moment the cache filled up into a multi-second pause.
    while (!this.withinSoftLimits(remainingCount, remainingSize)) {
      const batch = this.access.readCache("select cached resources to prune", () => (
        candidates.all(RESOURCE_CACHE_PRUNE_BATCH_SIZE)
      ));
      if (!batch) return false;
      if (batch.length === 0) return true;

      let left = { count: remainingCount, size: remainingSize };
      const pruned = this.access.writeCache("prune least recently used cached resources", () => {
        left = { count: remainingCount, size: remainingSize };
        const tx = this.db.transaction(() => {
          for (const { rowid } of batch) {
            if (this.withinSoftLimits(left.count, left.size)) break;
            const removed = remove.get(rowid);
            if (!removed) continue;
            left.count -= 1;
            left.size -= removed.size_bytes;
          }
        });
        tx();
      });
      if (!pruned) return false;
      remainingCount = left.count;
      remainingSize = left.size;
    }
    return true;
  }

  private maintainCacheAfterWrite(now: number, sizeBytes: number): void {
    this.writesSinceMaintenance += 1;
    this.bytesWrittenSinceMaintenance += sizeBytes;
    const maintenanceDue = this.lastMaintenanceAt === 0
      || this.writesSinceMaintenance >= RESOURCE_CACHE_MAINTENANCE_WRITE_INTERVAL
      || this.bytesWrittenSinceMaintenance >= RESOURCE_CACHE_MAINTENANCE_BYTE_INTERVAL
      || now - this.lastMaintenanceAt >= RESOURCE_CACHE_MAINTENANCE_TIME_INTERVAL_MS;
    if (!maintenanceDue) return;

    if (!this.pruneIfNeeded()) return;
    this.writesSinceMaintenance = 0;
    this.bytesWrittenSinceMaintenance = 0;
    this.lastMaintenanceAt = now;
  }

  get<T>(key: ResourceCacheKey, options: GetResourceOptions = {}): CachedResourceRecord<T> | null {
    const row = this.access.readCache("load cached resource", () => (
      this.db
        .query<ResourceCacheRow, [string, string, string, string, string]>(
          `SELECT namespace, kind, entity_key, variant_key, source_key, schema_version, payload, provenance,
                  fetched_at, stale_at, expires_at, last_accessed_at, size_bytes
           FROM resource_cache
           WHERE namespace = ? AND kind = ? AND entity_key = ? AND variant_key = ? AND source_key = ?`,
        )
        .get(
          key.namespace,
          key.kind,
          key.entityKey,
          normalizeVariantKey(key.variantKey),
          normalizeSourceKey(key.sourceKey),
        )
    ));

    if (!row) return null;
    if (!options.allowExpired && isExpired(row.expires_at)) return null;
    if (options.schemaVersion != null && row.schema_version !== options.schemaVersion) {
      this.deleteExact(key);
      return null;
    }

    const record = this.toCachedResource<T>(row);
    if (!record) {
      this.deleteExact(key);
      return null;
    }

    this.touchRead(record, options);
    return record;
  }

  list<T>(
    key: Pick<ResourceCacheKey, "namespace" | "kind" | "entityKey">,
    options: ListResourceOptions = {},
  ): CachedResourceRecord<T>[] {
    const variantKeys = options.variantKeys ? [...new Set(options.variantKeys.map(normalizeVariantKey))] : null;
    const sourceKeys = options.sourceKeys ? [...new Set(options.sourceKeys.map(normalizeSourceKey))] : null;
    if (variantKeys?.length === 0 || sourceKeys?.length === 0) return [];
    // The rows asked for only: an entity can hold dozens of variants (every
    // range of a price history, from every source), megabytes of payload
    // that a filter after the read threw away.
    const filters = [
      ...(variantKeys ? [`variant_key IN (${variantKeys.map(() => "?").join(", ")})`] : []),
      ...(sourceKeys ? [`source_key IN (${sourceKeys.map(() => "?").join(", ")})`] : []),
      ...(options.allowExpired ? [] : ["expires_at >= ?"]),
    ];
    const params: Array<string | number> = [
      key.namespace,
      key.kind,
      key.entityKey,
      ...(variantKeys ?? []),
      ...(sourceKeys ?? []),
      ...(options.allowExpired ? [] : [Date.now()]),
    ];
    const rows = this.access.readCache("list cached resources", () => (
      this.db
        .query<ResourceCacheRow, Array<string | number>>(
          `SELECT namespace, kind, entity_key, variant_key, source_key, schema_version, payload, provenance,
                  fetched_at, stale_at, expires_at, last_accessed_at, size_bytes
           FROM resource_cache
           WHERE ${["namespace = ?", "kind = ?", "entity_key = ?", ...filters].join(" AND ")}`,
        )
        .all(...params)
    )) ?? [];

    const records: CachedResourceRecord<T>[] = [];
    for (const row of sortRows(rows)) {
      if (options.schemaVersion != null && row.schema_version !== options.schemaVersion) {
        this.deleteExact({
          namespace: row.namespace,
          kind: row.kind,
          entityKey: row.entity_key,
          variantKey: row.variant_key,
          sourceKey: row.source_key,
        });
        continue;
      }
      const record = this.toCachedResource<T>(row);
      if (!record) {
        this.deleteExact({
          namespace: row.namespace,
          kind: row.kind,
          entityKey: row.entity_key,
          variantKey: row.variant_key,
          sourceKey: row.source_key,
        });
        continue;
      }
      records.push(record);
    }
    for (const record of records) this.touchRead(record, options);
    return records;
  }

  set<T>(key: ResourceCacheKey, value: T, options: SetResourceOptions): CachedResourceRecord<T> {
    const now = options.fetchedAt ?? Date.now();
    const payload = serializeJson(value);
    const provenance = options.provenance == null ? null : serializeJson(options.provenance);
    const schemaVersion = options.schemaVersion ?? DEFAULT_RESOURCE_SCHEMA_VERSION;
    const staleAt = now + options.cachePolicy.staleMs;
    const expiresAt = now + options.cachePolicy.expireMs;
    const sizeBytes = Buffer.byteLength(payload, "utf8");
    const rowKey = {
      namespace: key.namespace,
      kind: key.kind,
      entityKey: key.entityKey,
      variantKey: normalizeVariantKey(key.variantKey),
      sourceKey: normalizeSourceKey(key.sourceKey),
    };

    this.pendingTouches.delete(rowMapKey(rowKey));
    const saved = this.access.writeCache("save cached resource", () => {
      this.db
        .query(
          `INSERT OR REPLACE INTO resource_cache (
            namespace, kind, entity_key, variant_key, source_key, schema_version,
            payload, provenance, fetched_at, stale_at, expires_at, last_accessed_at, size_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rowKey.namespace,
          rowKey.kind,
          rowKey.entityKey,
          rowKey.variantKey,
          rowKey.sourceKey,
          schemaVersion,
          payload,
          provenance,
          now,
          staleAt,
          expiresAt,
          now,
          sizeBytes,
        );
    });

    if (saved) this.maintainCacheAfterWrite(Date.now(), sizeBytes);
    return {
      ...rowKey,
      value: JSON.parse(payload) as T,
      schemaVersion,
      provenance: provenance == null ? null : JSON.parse(provenance) as JsonValue,
      fetchedAt: now,
      staleAt,
      expiresAt,
      lastAccessedAt: now,
      sizeBytes,
      stale: isStale(staleAt),
      expired: isExpired(expiresAt),
    };
  }

  delete(key: ResourceCacheKey): void {
    this.deleteExact(key);
  }

  /** Asked for by the user, so it waits for another program's lock, and throws when it cannot get it. */
  clear(namespace?: string): void {
    if (!namespace) {
      this.pendingTouches.clear();
      this.access.run("clear cached resources", () => {
        this.db.query("DELETE FROM resource_cache").run();
      });
      return;
    }
    this.access.run("clear namespaced cached resources", () => {
      this.db.query("DELETE FROM resource_cache WHERE namespace = ?").run(namespace);
    });
  }
}
