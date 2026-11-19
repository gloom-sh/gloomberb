import type { Database } from "bun:sqlite";
import { createSqliteAccess, type SqliteAccess } from "./sqlite/access";
import { serializeJson } from "./sqlite/json";

export interface StoredTickerRecord {
  symbol: string;
  metadata: string;
}

/** A queued write's row (null metadata for a delete), one object per write. */
interface PendingTicker {
  metadata: string | null;
}

/**
 * A row to save that was built on an earlier copy of it, so what it writes is
 * only known once the write lands: `resolve` gets the row as stored at that
 * moment (null when there is none) and returns what to write, or null to
 * leave the row as it is. It can run more than once (a write the lock held up
 * runs again), so it has no effects of its own; `landed` hears what was
 * written, null for nothing. `preview` is what reads see while it waits.
 */
export interface ResolvedTickerRow {
  symbol: string;
  preview: unknown;
  resolve: (stored: string | null) => unknown;
  landed?: (written: string | null) => void;
}

export class TickerStore {
  /** Writes queued behind another program's lock, by symbol, read back until they land. */
  private readonly pending = new Map<string, PendingTicker>();

  constructor(
    private readonly db: Database,
    private readonly access: SqliteAccess = createSqliteAccess(db),
  ) {}

  getAll(): StoredTickerRecord[] {
    const rows = this.access.run("load tickers", () => (
      this.db
        .query<StoredTickerRecord, []>(
          "SELECT symbol, metadata FROM tickers ORDER BY symbol",
        )
        .all()
    ));
    if (this.pending.size === 0) return rows;
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    for (const [symbol, { metadata }] of this.pending) {
      if (metadata == null) bySymbol.delete(symbol);
      else bySymbol.set(symbol, { symbol, metadata });
    }
    return [...bySymbol.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }

  /**
   * A number that changes when another program (a `gloom` command) commits
   * to the database, and only then: SQLite's `data_version`. Null when the
   * database cannot be read just now.
   */
  changesElsewhere(): number | null {
    try {
      return this.access.run("read data version", () => (
        this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? null
      ));
    } catch {
      // Intentional ignore: an unreadable database is asked again on the next look.
      return null;
    }
  }

  /** Whether a write of `symbol` waits behind another program's lock: reads see it, the database does not yet. */
  isQueued(symbol: string): boolean {
    return this.pending.has(symbol);
  }

  get(symbol: string): string | null {
    const pending = this.pending.get(symbol);
    if (pending) return pending.metadata;
    const row = this.access.run("load ticker", () => (
      this.db
        .query<{ metadata: string }, [string]>(
          "SELECT metadata FROM tickers WHERE symbol = ?",
        )
        .get(symbol)
    ));
    return row?.metadata ?? null;
  }

  save(symbol: string, metadata: unknown): void {
    this.saveMany([{ symbol, metadata }]);
  }

  /** Saves every record in one transaction: one write for a whole import, not one per ticker. */
  saveMany(records: ReadonlyArray<{ symbol: string; metadata: unknown }>): void {
    if (records.length === 0) return;
    const rows = records.map((record) => ({ symbol: record.symbol, metadata: serializeJson(record.metadata) }));
    const now = Date.now();
    this.write(
      rows.length === 1 ? "save ticker" : "save tickers",
      rows.map((row) => [row.symbol, { metadata: row.metadata }]),
      () => {
        const statement = this.db.query(
          `INSERT OR REPLACE INTO tickers (symbol, metadata, updated_at)
           VALUES (?, ?, ?)`,
        );
        this.db.transaction(() => {
          for (const row of rows) statement.run(row.symbol, row.metadata, now);
        })();
      },
    );
  }

  /**
   * Saves rows whose content depends on the row stored when the write lands
   * (`ResolvedTickerRow`): each is read, resolved and written in one
   * immediate transaction, so another program's commit can never fall between
   * the read and the write, whether the write lands now or later, behind
   * another program's lock.
   */
  saveResolved(rows: readonly ResolvedTickerRow[]): void {
    if (rows.length === 0) return;
    this.write(
      rows.length === 1 ? "save ticker" : "save tickers",
      rows.map((row) => [row.symbol, { metadata: serializeJson(row.preview) }]),
      () => {
        const read = this.db.query<{ metadata: string }, [string]>("SELECT metadata FROM tickers WHERE symbol = ?");
        const insert = this.db.query(
          `INSERT OR REPLACE INTO tickers (symbol, metadata, updated_at)
           VALUES (?, ?, ?)`,
        );
        const now = Date.now();
        const written = this.db.transaction(() => rows.map((row) => {
          const next = row.resolve(read.get(row.symbol)?.metadata ?? null);
          if (next == null) return null;
          const metadata = serializeJson(next);
          insert.run(row.symbol, metadata, now);
          return metadata;
        })).immediate();
        rows.forEach((row, index) => row.landed?.(written[index] ?? null));
      },
    );
  }

  delete(symbol: string): void {
    this.write("delete ticker", [[symbol, { metadata: null }]], () => {
      this.db.query("DELETE FROM tickers WHERE symbol = ?").run(symbol);
    });
  }

  /**
   * Runs `statement` through the write queue, reading `entries` back until it
   * lands. A write of one row replaces a queued write of the same row.
   */
  private write(operationName: string, entries: Array<[string, PendingTicker]>, statement: () => void): void {
    for (const [symbol, entry] of entries) this.pending.set(symbol, entry);
    this.access.write(operationName, statement, {
      ...(entries.length === 1 ? { key: `tickers\u0000${entries[0]![0]}` } : {}),
      settled: () => {
        for (const [symbol, entry] of entries) {
          if (this.pending.get(symbol) === entry) this.pending.delete(symbol);
        }
      },
    });
  }
}
