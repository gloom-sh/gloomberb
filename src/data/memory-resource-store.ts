import type {
  CachedResourceRecord,
  GetResourceOptions,
  ListResourceOptions,
  ResourceCacheKey,
  SetResourceOptions,
} from "./resource-store";

const DEFAULT_RESOURCE_SCHEMA_VERSION = 1;

function normalizeVariantKey(value: string | undefined): string {
  return value ?? "";
}

function normalizeSourceKey(value: string | undefined): string {
  return value ?? "";
}

function buildMapKey(key: ResourceCacheKey): string {
  return [
    key.namespace,
    key.kind,
    key.entityKey,
    normalizeVariantKey(key.variantKey),
    normalizeSourceKey(key.sourceKey),
  ].join("\u0000");
}

function isExpired(record: CachedResourceRecord): boolean {
  return record.expiresAt < Date.now();
}

function isStale(record: CachedResourceRecord): boolean {
  return record.staleAt < Date.now();
}

export class MemoryResourceStore {
  private readonly records = new Map<string, CachedResourceRecord>();

  get<T>(key: ResourceCacheKey, options: GetResourceOptions = {}): CachedResourceRecord<T> | null {
    const record = this.records.get(buildMapKey(key)) as CachedResourceRecord<T> | undefined;
    if (!record) return null;
    if (!options.allowExpired && isExpired(record)) return null;
    if (options.schemaVersion != null && record.schemaVersion !== options.schemaVersion) {
      this.delete(key);
      return null;
    }
    if (options.touch !== false) {
      record.lastAccessedAt = Date.now();
    }
    record.stale = isStale(record);
    record.expired = isExpired(record);
    return record;
  }

  list<T>(
    key: Pick<ResourceCacheKey, "namespace" | "kind" | "entityKey">,
    options: ListResourceOptions = {},
  ): CachedResourceRecord<T>[] {
    const allowedVariantKeys = options.variantKeys ? new Set(options.variantKeys.map(normalizeVariantKey)) : null;
    const allowedSourceKeys = options.sourceKeys ? new Set(options.sourceKeys.map(normalizeSourceKey)) : null;
    const records = [...this.records.values()].filter((record) => {
      if (record.namespace !== key.namespace || record.kind !== key.kind || record.entityKey !== key.entityKey) return false;
      if (!options.allowExpired && isExpired(record)) return false;
      if (allowedVariantKeys && !allowedVariantKeys.has(record.variantKey)) return false;
      if (allowedSourceKeys && !allowedSourceKeys.has(record.sourceKey)) return false;
      if (options.schemaVersion != null && record.schemaVersion !== options.schemaVersion) return false;
      return true;
    });
    return records
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
      .map((record) => this.get<T>(record, options))
      .filter((record): record is CachedResourceRecord<T> => record != null);
  }

  set<T>(
    key: ResourceCacheKey,
    value: T,
    options: SetResourceOptions,
  ): CachedResourceRecord<T> {
    const now = options.fetchedAt ?? Date.now();
    const record: CachedResourceRecord<T> = {
      namespace: key.namespace,
      kind: key.kind,
      entityKey: key.entityKey,
      variantKey: normalizeVariantKey(key.variantKey),
      sourceKey: normalizeSourceKey(key.sourceKey),
      value,
      schemaVersion: options.schemaVersion ?? DEFAULT_RESOURCE_SCHEMA_VERSION,
      provenance: options.provenance ?? null,
      fetchedAt: now,
      staleAt: now + options.cachePolicy.staleMs,
      expiresAt: now + options.cachePolicy.expireMs,
      lastAccessedAt: now,
      sizeBytes: 0,
      stale: false,
      expired: false,
    };
    this.records.set(buildMapKey(record), record);
    return record;
  }

  delete(key: ResourceCacheKey): void {
    this.records.delete(buildMapKey(key));
  }
}
