import type { Database } from "bun:sqlite";
import { safeParseJson, serializeJson } from "./sqlite/json";
import { withSqliteBusyRetry } from "./sqlite/retry";

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

export class PluginStateStore {
  private readonly cache = new Map<string, CachedPluginStateRecord>();

  constructor(private readonly db: Database) {}

  get<T>(pluginId: string, key: string, schemaVersion = DEFAULT_PLUGIN_STATE_SCHEMA_VERSION): PluginStateRecord<T> | null {
    const cacheKey = `${pluginId}:${key}`;
    const row = withSqliteBusyRetry("load plugin state", () => (
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
    const records = entries.map((entry) => ({
      pluginId: entry.pluginId,
      key: entry.key,
      value: entry.value,
      schemaVersion: entry.schemaVersion ?? DEFAULT_PLUGIN_STATE_SCHEMA_VERSION,
      rawValue: serializeJson(entry.value),
    }));

    withSqliteBusyRetry("save plugin state", () => {
      const insert = this.db.query(
        `INSERT OR REPLACE INTO plugin_state (plugin_id, key, schema_version, value, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const tx = this.db.transaction(() => {
        for (const record of records) {
          insert.run(record.pluginId, record.key, record.schemaVersion, record.rawValue, updatedAt);
        }
      });
      tx();
    });

    for (const record of records) {
      this.cache.set(`${record.pluginId}:${record.key}`, {
        value: record.value,
        schemaVersion: record.schemaVersion,
        updatedAt,
        rawValue: record.rawValue,
      });
    }
  }

  delete(pluginId: string, key: string): void {
    withSqliteBusyRetry("delete plugin state", () => {
      this.db.query("DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?").run(pluginId, key);
    });
    this.cache.delete(`${pluginId}:${key}`);
  }

  keys(pluginId: string): string[] {
    return withSqliteBusyRetry("list plugin state keys", () => (
      this.db
        .query<{ key: string }, [string]>(
          "SELECT key FROM plugin_state WHERE plugin_id = ? ORDER BY key",
        )
        .all(pluginId)
        .map((row) => row.key)
    ));
  }

  pluginIds(): string[] {
    return withSqliteBusyRetry("list plugin state ids", () => (
      this.db
        .query<{ plugin_id: string }, []>(
          "SELECT DISTINCT plugin_id FROM plugin_state ORDER BY plugin_id",
        )
        .all()
        .map((row) => row.plugin_id)
    ));
  }

  clear(pluginId: string): void {
    withSqliteBusyRetry("clear plugin state", () => {
      this.db.query("DELETE FROM plugin_state WHERE plugin_id = ?").run(pluginId);
    });
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.startsWith(`${pluginId}:`)) {
        this.cache.delete(cacheKey);
      }
    }
  }
}
