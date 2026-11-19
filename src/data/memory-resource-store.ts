import type {
  CachedResourceRecord,
  GetResourceOptions,
  ListResourceOptions,
  ResourceCacheKey,
  SetResourceOptions,
} from "./resource-store";
import { safeParseJson, serializeJson } from "./sqlite/json";
import { packJson, unpackJson } from "./packed-json";
import { logFailure } from "../utils/log-failure";
import { proResourceAccounts, ProResourceAccess } from "./pro-resource-access";

const DEFAULT_RESOURCE_SCHEMA_VERSION = 1;
const encoder = new TextEncoder();

export const WARM_RESOURCE_BUDGET = { maxBytes: 8 * 1024 * 1024, maxRows: 2_000 };

function jsonBytes(value: unknown): number {
  return encoder.encode(serializeJson(value)).byteLength;
}

export type PackedResourceRecord = Omit<CachedResourceRecord, "value"> & { valueJson: string };
export type WarmResourceRecord = CachedResourceRecord | PackedResourceRecord;

export function packWarmResource(record: CachedResourceRecord): WarmResourceRecord {
  if (!record.namespace.startsWith("plugin:") || record.value === null || typeof record.value !== "object") return record;
  const { value, ...metadata } = record;
  return { ...metadata, valueJson: serializeJson(value) };
}

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
  private readonly proCandidates = new Map<string, Set<string>>();
  private readonly proAccountsByKey = new Map<string, string[]>();
  protected readonly proAccess = new ProResourceAccess();
  private bytes = 0;

  constructor(private readonly budget: Readonly<typeof WARM_RESOURCE_BUDGET> = WARM_RESOURCE_BUDGET) {}

  private forget(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    this.bytes -= record.sizeBytes;
    this.records.delete(key);
    for (const account of this.proAccountsByKey.get(key) ?? []) {
      const keys = this.proCandidates.get(account)!;
      keys.delete(key);
      if (keys.size === 0) this.proCandidates.delete(account);
    }
    this.proAccountsByKey.delete(key);
  }

  private remember(record: CachedResourceRecord): void {
    const key = buildMapKey(record);
    this.forget(key);
    if (record.sizeBytes > this.budget.maxBytes) return;
    this.records.set(key, record);
    const accounts = proResourceAccounts(record);
    if (accounts.length) this.proAccountsByKey.set(key, accounts);
    for (const account of accounts) {
      let keys = this.proCandidates.get(account);
      if (!keys) this.proCandidates.set(account, keys = new Set());
      keys.add(key);
    }
    this.bytes += record.sizeBytes;
    while (this.records.size > this.budget.maxRows || this.bytes > this.budget.maxBytes) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.forget(oldest.value);
    }
  }

  get<T>(key: ResourceCacheKey, options: GetResourceOptions = {}): CachedResourceRecord<T> | null {
    const id = buildMapKey(key);
    const record = this.records.get(id) as CachedResourceRecord<T> | undefined;
    if (!record) return null;
    if (!options.allowExpired && isExpired(record)) return null;
    if (options.schemaVersion != null && record.schemaVersion !== options.schemaVersion) {
      this.delete(key);
      return null;
    }
    if (options.touch !== false) {
      this.records.delete(id);
      this.records.set(id, record);
      if (options.touchIntervalMs == null || Date.now() - record.lastAccessedAt >= options.touchIntervalMs) {
        record.lastAccessedAt = Date.now();
      }
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
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)
      .map((record) => this.get<T>(record, options))
      .filter((record): record is CachedResourceRecord<T> => record != null)
      .reverse();
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
      sizeBytes: jsonBytes(value),
      stale: false,
      expired: false,
    };
    if (this.proAccess.permits(key)) this.remember(record);
    return record;
  }

  setProResourceAccess(account: string, allowed: boolean): void {
    if (!this.proAccess.update(account, allowed)) return;
    if (!allowed) for (const id of this.proCandidates.get(account) ?? []) this.forget(id);
    this.onProResourceAccessChanged(account, allowed);
  }

  protected onProResourceAccessChanged(_account: string, _allowed: boolean): void {}

  delete(key: ResourceCacheKey): void {
    this.forget(buildMapKey(key));
  }

  /** Puts back a record saved elsewhere, with its own times. */
  protected restore(record: WarmResourceRecord): void {
    if ("valueJson" in record) {
      const { valueJson, ...metadata } = record;
      const packed = record.namespace.startsWith("plugin:") ? packJson(valueJson) : valueJson;
      let decoded: WeakRef<object> | undefined;
      const restored = { ...metadata, sizeBytes: metadata.sizeBytes || encoder.encode(valueJson).byteLength, get value() {
        const current = decoded?.deref();
        if (current) return current;
        try {
          const data = safeParseJson<object>(unpackJson(packed));
          if (data && typeof data === "object") decoded = new WeakRef(data);
          return data;
        } catch (error) {
          logFailure("data.memory-resource-store", "Reading a packed resource failed")(error);
          return null;
        }
      } };
      this.remember(restored);
      return;
    }
    this.remember({ ...record, sizeBytes: record.sizeBytes || jsonBytes(record.value) });
  }
}

export function resourceRecordKey(key: ResourceCacheKey): string {
  return buildMapKey(key);
}

/** The read time last handed to a sink, per record, so a read that moved nothing sends nothing. */
const touchedAt = new WeakMap<object, number>();

/** Where a renderer without the cache database keeps the records that must outlive a restart. */
export interface ResourceRecordSink {
  set(record: CachedResourceRecord): void;
  delete(key: ResourceCacheKey): void;
  setProResourceAccess(account: string, allowed: boolean): void;
  /** A read moved the record up the eviction order, so a record read every launch is not the first to go. */
  touch?(key: ResourceCacheKey, at: number): void;
}

/**
 * The in-memory store, except that the records `durable` picks are handed to
 * a sink as they change and come back from it on the next start. The desktop
 * view and the web app have no cache database of their own: the desktop's
 * sink is the Bun process's, the web app's the browser's (see
 * data/durable-resources.ts), so a pane opens on its saved copy after a
 * restart as it does in the terminal.
 */
export class WriteThroughResourceStore extends MemoryResourceStore {
  constructor(
    saved: readonly WarmResourceRecord[],
    private readonly sink: ResourceRecordSink,
    private readonly durable: (key: ResourceCacheKey) => boolean,
    budget?: Readonly<typeof WARM_RESOURCE_BUDGET>,
  ) {
    super(budget);
    for (const record of [...saved].sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)) {
      if (durable(record)) this.restore("valueJson" in record ? record : packWarmResource(record));
    }
  }

  override get<T>(key: ResourceCacheKey, options: GetResourceOptions = {}): CachedResourceRecord<T> | null {
    const record = super.get<T>(key, options);
    const previousTouch = record ? touchedAt.get(record) ?? 0 : 0;
    if (record && options.touch !== false && this.sink.touch && record.lastAccessedAt - previousTouch >= 30_000 && this.durable(record)) {
      touchedAt.set(record, record.lastAccessedAt);
      this.sink.touch(record, record.lastAccessedAt);
    }
    return record;
  }

  override set<T>(key: ResourceCacheKey, value: T, options: SetResourceOptions): CachedResourceRecord<T> {
    const record = super.set(key, value, options);
    if (this.durable(key) && this.proAccess.permits(key)) this.sink.set(record);
    return record;
  }

  override delete(key: ResourceCacheKey): void {
    super.delete(key);
    if (this.durable(key)) this.sink.delete(key);
  }

  protected override onProResourceAccessChanged(account: string, allowed: boolean): void {
    this.sink.setProResourceAccess(account, allowed);
  }
}
