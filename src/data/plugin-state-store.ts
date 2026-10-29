import type { Database } from "bun:sqlite";
import { createSqliteAccess, type SqliteAccess } from "./sqlite/access";
import { safeParseJson, serializeJson } from "./sqlite/json";

const DEFAULT_PLUGIN_STATE_SCHEMA_VERSION = 1;

export interface PluginStateRecord<T = unknown> {
  value: T;
  schemaVersion: number;
  updatedAt: number;
}

export interface PluginStateSetEntry {
  pluginId: string;
  key: string;
  value: unknown;
  schemaVersion?: number;
}

interface CachedPluginStateRecord {
  value: unknown;
  schemaVersion: number;
  updatedAt: number;
  rawValue: string;
}

/** A queued write's record (null for a delete), one object per write. */
interface PendingPluginState {
  pluginId: string;
  key: string;
  record: CachedPluginStateRecord | null;
}

function stateKey(pluginId: string, key: string): string {
  return `${pluginId}:${key}`;
}

/** A queued write's row, unambiguous where ids and keys hold colons. */
function rowKey(pluginId: string, key: string): string {
  return `${pluginId}\u0000${key}`;
}

export class PluginStateStore {
  private readonly cache = new Map<string, CachedPluginStateRecord>();
  /** Writes queued behind another program's lock, read back until they land. */
  private readonly pending = new Map<string, PendingPluginState>();

  constructor(
    private readonly db: Database,
    private readonly access: SqliteAccess = createSqliteAccess(db),
  ) {}

  get<T>(pluginId: string, key: string, schemaVersion = DEFAULT_PLUGIN_STATE_SCHEMA_VERSION): PluginStateRecord<T> | null {
    const cacheKey = stateKey(pluginId, key);
    const pending = this.pending.get(rowKey(pluginId, key));
    if (pending) {
      return pending.record?.schemaVersion === schemaVersion ? pending.record as PluginStateRecord<T> : null;
    }
    const row = this.access.run("load plugin state", () => (
      this.db
        .query<{ schema_version: number; value: string; updated_at: number }, [string, string]>(
          "SELECT schema_version, value, updated_at FROM plugin_state WHERE plugin_id = ? AND key = ?",
        )
        .get(pluginId, key)
    ));
    if (!row) {
      this.cache.delete(cacheKey);
      return null;
    }
    if (row.schema_version !== schemaVersion) {
      this.cache.delete(cacheKey);
      this.delete(pluginId, key);
      return null;
    }

    const cached = this.cache.get(cacheKey);
    if (cached && cached.schemaVersion === row.schema_version && cached.updatedAt === row.updated_at && cached.rawValue === row.value) {
      return cached as PluginStateRecord<T>;
    }

    const value = safeParseJson<T>(row.value);
    if (value == null) {
      this.cache.delete(cacheKey);
      this.delete(pluginId, key);
      return null;
    }

    const record: CachedPluginStateRecord = {
      value,
      schemaVersion: row.schema_version,
      updatedAt: row.updated_at,
      rawValue: row.value,
    };
    this.cache.set(cacheKey, record);
    return record as PluginStateRecord<T>;
  }

  set(pluginId: string, key: string, value: unknown, schemaVersion = DEFAULT_PLUGIN_STATE_SCHEMA_VERSION): void {
    this.setMany([{ pluginId, key, value, schemaVersion }]);
  }

  setMany(entries: PluginStateSetEntry[]): void {
    if (entries.length === 0) return;
    const updatedAt = Date.now();
    const writes: PendingPluginState[] = entries.map((entry) => ({
      pluginId: entry.pluginId,
      key: entry.key,
      record: {
        value: entry.value,
        schemaVersion: entry.schemaVersion ?? DEFAULT_PLUGIN_STATE_SCHEMA_VERSION,
        updatedAt,
        rawValue: serializeJson(entry.value),
      },
    }));

    this.write("save plugin state", writes, writes.length === 1, () => {
      const insert = this.db.query(
        `INSERT OR REPLACE INTO plugin_state (plugin_id, key, schema_version, value, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const tx = this.db.transaction(() => {
        for (const { pluginId, key, record } of writes) {
          insert.run(pluginId, key, record!.schemaVersion, record!.rawValue, updatedAt);
        }
      });
      tx();
    });

    for (const { pluginId, key, record } of writes) this.cache.set(stateKey(pluginId, key), record!);
  }

  delete(pluginId: string, key: string): void {
    this.write("delete plugin state", [{ pluginId, key, record: null }], true, () => {
      this.db.query("DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?").run(pluginId, key);
    });
    this.cache.delete(stateKey(pluginId, key));
  }

  keys(pluginId: string): string[] {
    const stored = this.access.run("list plugin state keys", () => (
      this.db
        .query<{ key: string }, [string]>(
          "SELECT key FROM plugin_state WHERE plugin_id = ? ORDER BY key",
        )
        .all(pluginId)
        .map((row) => row.key)
    ));
    if (this.pending.size === 0) return stored;
    const keys = new Set(stored);
    for (const entry of this.pending.values()) {
      if (entry.pluginId !== pluginId) continue;
      if (entry.record) keys.add(entry.key);
      else keys.delete(entry.key);
    }
    return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  pluginIds(): string[] {
    const stored = this.access.run("list plugin state ids", () => (
      this.db
        .query<{ plugin_id: string }, []>(
          "SELECT DISTINCT plugin_id FROM plugin_state ORDER BY plugin_id",
        )
        .all()
        .map((row) => row.plugin_id)
    ));
    if (this.pending.size === 0) return stored;
    const ids = new Set(stored);
    for (const { pluginId } of this.pending.values()) {
      if (this.keys(pluginId).length > 0) ids.add(pluginId);
      else ids.delete(pluginId);
    }
    return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  clear(pluginId: string): void {
    const cleared = this.keys(pluginId).map((key): PendingPluginState => ({ pluginId, key, record: null }));
    // Deletes rows this store may not know of: never one row's write.
    this.write("clear plugin state", cleared, false, () => {
      this.db.query("DELETE FROM plugin_state WHERE plugin_id = ?").run(pluginId);
    });
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.startsWith(`${pluginId}:`)) {
        this.cache.delete(cacheKey);
      }
    }
  }

  /**
   * Runs `statement` through the write queue, reading `entries` back until it
   * lands. A write of exactly one row (`oneRow`) replaces a queued write of
   * the same row.
   */
  private write(operationName: string, entries: PendingPluginState[], oneRow: boolean, statement: () => void): void {
    for (const entry of entries) this.pending.set(rowKey(entry.pluginId, entry.key), entry);
    const only = oneRow && entries.length === 1 ? entries[0] : undefined;
    this.access.write(operationName, statement, {
      ...(only ? { key: `plugin_state\u0000${rowKey(only.pluginId, only.key)}` } : {}),
      settled: () => {
        for (const entry of entries) {
          const pendingKey = rowKey(entry.pluginId, entry.key);
          if (this.pending.get(pendingKey) === entry) this.pending.delete(pendingKey);
        }
      },
    });
  }
}
