import type { Database } from "bun:sqlite";
import { createSqliteAccess, type SqliteAccess } from "./sqlite/access";
import { safeParseJson, serializeJson } from "./sqlite/json";

const DEFAULT_SESSION_SCHEMA_VERSION = 1;

export interface SessionSnapshotRecord<T = unknown> {
  sessionId: string;
  value: T;
  schemaVersion: number;
  updatedAt: number;
}

/** A queued write's row (null for a delete), one object per write. */
interface PendingSession {
  row: { schema_version: number; value: string; updated_at: number } | null;
}

export class SessionStore {
  /** Writes queued behind another program's lock, read back until they land. */
  private readonly pending = new Map<string, PendingSession>();

  constructor(
    private readonly db: Database,
    private readonly access: SqliteAccess = createSqliteAccess(db),
  ) {}

  get<T>(sessionId = "app", schemaVersion = DEFAULT_SESSION_SCHEMA_VERSION): SessionSnapshotRecord<T> | null {
    const pending = this.pending.get(sessionId);
    const row = pending ? pending.row : this.access.run("load session snapshot", () => (
      this.db
        .query<{ schema_version: number; value: string; updated_at: number }, [string]>(
          "SELECT schema_version, value, updated_at FROM session_snapshots WHERE session_id = ?",
        )
        .get(sessionId)
    ));
    if (!row) return null;
    if (row.schema_version !== schemaVersion) {
      if (!pending) this.delete(sessionId);
      return null;
    }
    const value = safeParseJson<T>(row.value);
    if (value == null) {
      if (!pending) this.delete(sessionId);
      return null;
    }
    return {
      sessionId,
      value,
      schemaVersion: row.schema_version,
      updatedAt: row.updated_at,
    };
  }

  set(sessionId: string, value: unknown, schemaVersion = DEFAULT_SESSION_SCHEMA_VERSION): void {
    const row = { schema_version: schemaVersion, value: serializeJson(value), updated_at: Date.now() };
    this.write("save session snapshot", sessionId, { row }, () => {
      this.db
        .query(
          `INSERT OR REPLACE INTO session_snapshots (session_id, schema_version, value, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sessionId, row.schema_version, row.value, row.updated_at);
    });
  }

  delete(sessionId: string): void {
    this.write("delete session snapshot", sessionId, { row: null }, () => {
      this.db.query("DELETE FROM session_snapshots WHERE session_id = ?").run(sessionId);
    });
  }

  private write(operationName: string, sessionId: string, entry: PendingSession, statement: () => void): void {
    this.pending.set(sessionId, entry);
    this.access.write(operationName, statement, {
      key: `session_snapshots\u0000${sessionId}`,
      settled: () => {
        if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
      },
    });
  }
}
