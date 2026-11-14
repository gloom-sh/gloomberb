import type { PersistedResourceValue } from "../types/persistence";
import type { PluginPersistence } from "../types/plugin";

/**
 * A mid-morning UTC moment for a test to hold the clock at (`setSystemTime`),
 * when it reads the time of day off a copy `seedResource` saved: that copy is
 * dated a minute before the clock, so in the first minute of a day it is from
 * the day before and reads with its date ("saved copy from 13 Nov 23:59")
 * instead of "saved copy from 23:59". Its minutes and seconds are ones no time
 * zone's midnight falls on, so the minute before it is never another day's
 * wherever the test runs.
 */
export const SAVED_COPY_TEST_NOW = Date.parse("2026-11-13T10:17:42Z");

export class MemoryPluginPersistence implements PluginPersistence {
  private readonly state = new Map<string, { schemaVersion: number; value: unknown }>();
  private readonly resources = new Map<string, PersistedResourceValue<unknown>>();

  getState<T = unknown>(key: string, options?: { schemaVersion?: number }): T | null {
    const record = this.state.get(key);
    if (!record) return null;
    if (options?.schemaVersion != null && record.schemaVersion !== options.schemaVersion) {
      this.state.delete(key);
      return null;
    }
    return record.value as T;
  }

  setState(key: string, value: unknown, options?: { schemaVersion?: number }): void {
    this.state.set(key, { schemaVersion: options?.schemaVersion ?? 1, value });
  }

  deleteState(key: string): void {
    this.state.delete(key);
  }

  getResource<T = unknown>(
    kind: string,
    key: string,
    options?: { sourceKey?: string; schemaVersion?: number; allowExpired?: boolean },
  ): PersistedResourceValue<T> | null {
    const resourceKey = this.resourceKey(kind, key, options?.sourceKey);
    const record = this.resources.get(resourceKey);
    if (!record) return null;
    if (options?.schemaVersion != null && record.schemaVersion !== options.schemaVersion) {
      this.resources.delete(resourceKey);
      return null;
    }
    const value = this.withFreshness(record);
    if (!options?.allowExpired && value.expired) return null;
    return value as PersistedResourceValue<T>;
  }

  setResource<T = unknown>(
    kind: string,
    key: string,
    value: T,
    options: {
      cachePolicy: { staleMs: number; expireMs: number };
      sourceKey?: string;
      schemaVersion?: number;
      provenance?: unknown;
    },
  ): PersistedResourceValue<T> {
    const now = Date.now();
    const record: PersistedResourceValue<T> = {
      value,
      fetchedAt: now,
      staleAt: now + options.cachePolicy.staleMs,
      expiresAt: now + options.cachePolicy.expireMs,
      sourceKey: options.sourceKey ?? "",
      schemaVersion: options.schemaVersion ?? 1,
      provenance: options.provenance,
      stale: false,
      expired: false,
    };
    this.resources.set(this.resourceKey(kind, key, options.sourceKey), record);
    return record;
  }

  deleteResource(kind: string, key: string, options?: { sourceKey?: string }): void {
    this.resources.delete(this.resourceKey(kind, key, options?.sourceKey));
  }

  seedResource<T>(
    kind: string,
    key: string,
    value: T,
    options: {
      sourceKey?: string;
      stale?: boolean;
      expired?: boolean;
      schemaVersion?: number;
      provenance?: unknown;
    } = {},
  ): void {
    // A minute back: see SAVED_COPY_TEST_NOW for what a test that reads this copy's time of day holds the clock for.
    const now = Date.now();
    this.resources.set(this.resourceKey(kind, key, options.sourceKey), {
      value,
      fetchedAt: now - 60_000,
      staleAt: options.stale ? now - 1 : now + 60_000,
      expiresAt: options.expired ? now - 1 : now + 60_000,
      sourceKey: options.sourceKey ?? "",
      schemaVersion: options.schemaVersion ?? 1,
      provenance: options.provenance,
      stale: !!options.stale,
      expired: !!options.expired,
    });
  }

  private resourceKey(kind: string, key: string, sourceKey = ""): string {
    return `${kind}:${key}:${sourceKey}`;
  }

  private withFreshness<T>(record: PersistedResourceValue<T>): PersistedResourceValue<T> {
    const now = Date.now();
    return {
      ...record,
      stale: now >= record.staleAt,
      expired: now >= record.expiresAt,
    };
  }
}
