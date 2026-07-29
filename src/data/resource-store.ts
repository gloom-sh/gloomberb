import type { Database } from "bun:sqlite";
import type { CachePolicy, PersistedResourceValue } from "../types/persistence";
import type { JsonValue } from "./sqlite/json";
import { safeParseJson, serializeJson } from "./sqlite/json";
import { trySqliteBusyOperation, withSqliteBusyRetry } from "./sqlite/retry";

const RESOURCE_CACHE_SOFT_ROW_LIMIT = 25_000;
const RESOURCE_CACHE_SOFT_SIZE_LIMIT = 100 * 1024 * 1024;
const RESOURCE_CACHE_MAINTENANCE_WRITE_INTERVAL = 250;
const RESOURCE_CACHE_MAINTENANCE_BYTE_INTERVAL = Math.floor(
  RESOURCE_CACHE_SOFT_SIZE_LIMIT / RESOURCE_CACHE_MAINTENANCE_WRITE_INTERVAL,
);
const RESOURCE_CACHE_MAINTENANCE_TIME_INTERVAL_MS = 5 * 60_000;
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

  constructor(private readonly db: Database) {}

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
    withSqliteBusyRetry("delete cached resource", () => {
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

  private touch(key: ResourceCacheKey): number | null {
    const touchedAt = Date.now();
    const result = trySqliteBusyOperation("touch cached resource", () => {
      this.db
        .query(
          `UPDATE resource_cache
           SET last_accessed_at = ?
           WHERE namespace = ? AND kind = ? AND entity_key = ? AND variant_key = ? AND source_key = ?`,
        )
        .run(
          touchedAt,
          key.namespace,
          key.kind,
          key.entityKey,
          normalizeVariantKey(key.variantKey),
          normalizeSourceKey(key.sourceKey),
        );
      return touchedAt;
    });
    return result;
  }

  private pruneIfNeeded(): void {
    const stats = withSqliteBusyRetry("read resource cache size", () => (
      this.db
        .query<{ count: number; total_size: number }, []>(
          "SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM resource_cache",
        )
        .get()
    ));
    const count = stats?.count ?? 0;
    const totalSize = stats?.total_size ?? 0;
    if (count <= RESOURCE_CACHE_SOFT_ROW_LIMIT && totalSize <= RESOURCE_CACHE_SOFT_SIZE_LIMIT) return;

    withSqliteBusyRetry("prune expired cached resources", () => {
      this.db.query("DELETE FROM resource_cache WHERE expires_at < ?").run(Date.now());
    });

    const remaining = withSqliteBusyRetry("read pruned resource cache size", () => (
      this.db
        .query<{ count: number; total_size: number }, []>(
          "SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM resource_cache",
        )
        .get()
    ));
    const remainingCount = remaining?.count ?? 0;
    const remainingSize = remaining?.total_size ?? 0;
    if (remainingCount <= RESOURCE_CACHE_SOFT_ROW_LIMIT && remainingSize <= RESOURCE_CACHE_SOFT_SIZE_LIMIT) return;

    const pruneCandidates = withSqliteBusyRetry("select cached resources to prune", () => (
      this.db
        .query<{
          namespace: string;
          kind: string;
          entity_key: string;
          variant_key: string;
          source_key: string;
          size_bytes: number;
        }, []>(
          `SELECT namespace, kind, entity_key, variant_key, source_key, size_bytes
           FROM resource_cache
           ORDER BY last_accessed_at ASC, fetched_at ASC`,
        )
        .all()
    ));

    let projectedCount = remainingCount;
    let projectedSize = remainingSize;
    const rowsToDelete = [] as typeof pruneCandidates;
    for (const row of pruneCandidates) {
      if (
        projectedCount <= RESOURCE_CACHE_SOFT_ROW_LIMIT
        && projectedSize <= RESOURCE_CACHE_SOFT_SIZE_LIMIT
      ) {
        break;
      }
      rowsToDelete.push(row);
      projectedCount -= 1;
      projectedSize -= row.size_bytes;
    }

    if (rowsToDelete.length === 0) return;
    withSqliteBusyRetry("prune least recently used cached resources", () => {
      const remove = this.db.query(
        `DELETE FROM resource_cache
         WHERE namespace = ? AND kind = ? AND entity_key = ? AND variant_key = ? AND source_key = ?`,
      );
      const tx = this.db.transaction(() => {
        for (const row of rowsToDelete) {
          remove.run(row.namespace, row.kind, row.entity_key, row.variant_key, row.source_key);
        }
      });
      tx();
    });
  }

  private maintainCacheAfterWrite(now: number, sizeBytes: number): void {
    this.writesSinceMaintenance += 1;
    this.bytesWrittenSinceMaintenance += sizeBytes;
    const maintenanceDue = this.lastMaintenanceAt === 0
      || this.writesSinceMaintenance >= RESOURCE_CACHE_MAINTENANCE_WRITE_INTERVAL
      || this.bytesWrittenSinceMaintenance >= RESOURCE_CACHE_MAINTENANCE_BYTE_INTERVAL
      || now - this.lastMaintenanceAt >= RESOURCE_CACHE_MAINTENANCE_TIME_INTERVAL_MS;
    if (!maintenanceDue) return;

    this.pruneIfNeeded();
    this.writesSinceMaintenance = 0;
    this.bytesWrittenSinceMaintenance = 0;
    this.lastMaintenanceAt = now;
  }

  get<T>(key: ResourceCacheKey, options: GetResourceOptions = {}): CachedResourceRecord<T> | null {
    const row = withSqliteBusyRetry("load cached resource", () => (
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

    if (options.touch !== false) {
      const touchedAt = this.touch(key);
      if (touchedAt != null) {
        record.lastAccessedAt = touchedAt;
      }
    }
    return record;
  }

  list<T>(
    key: Pick<ResourceCacheKey, "namespace" | "kind" | "entityKey">,
    options: ListResourceOptions = {},
  ): CachedResourceRecord<T>[] {
    const rows = withSqliteBusyRetry("list cached resources", () => (
      this.db
        .query<ResourceCacheRow, [string, string, string]>(
          `SELECT namespace, kind, entity_key, variant_key, source_key, schema_version, payload, provenance,
                  fetched_at, stale_at, expires_at, last_accessed_at, size_bytes
           FROM resource_cache
           WHERE namespace = ? AND kind = ? AND entity_key = ?`,
        )
        .all(key.namespace, key.kind, key.entityKey)
    ));

    const allowedVariantKeys = options.variantKeys ? new Set(options.variantKeys.map(normalizeVariantKey)) : null;
    const allowedSourceKeys = options.sourceKeys ? new Set(options.sourceKeys.map(normalizeSourceKey)) : null;

    const records: CachedResourceRecord<T>[] = [];
    for (const row of sortRows(rows)) {
      if (!options.allowExpired && isExpired(row.expires_at)) continue;
      if (allowedVariantKeys && !allowedVariantKeys.has(row.variant_key)) continue;
      if (allowedSourceKeys && !allowedSourceKeys.has(row.source_key)) continue;
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
    if (options.touch !== false) {
      for (const record of records) {
        const touchedAt = this.touch(record);
        if (touchedAt != null) record.lastAccessedAt = touchedAt;
      }
    }
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

    withSqliteBusyRetry("save cached resource", () => {
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

    this.maintainCacheAfterWrite(Date.now(), sizeBytes);
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

  clear(namespace?: string): void {
    if (!namespace) {
      withSqliteBusyRetry("clear cached resources", () => {
        this.db.query("DELETE FROM resource_cache").run();
      });
      return;
    }
    withSqliteBusyRetry("clear namespaced cached resources", () => {
      this.db.query("DELETE FROM resource_cache WHERE namespace = ?").run(namespace);
    });
  }
}
