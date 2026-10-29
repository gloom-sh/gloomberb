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

  delete(symbol: string): void {
    this.write("delete ticker", [[symbol, { metadata: null }]], () => {
      this.db.query("DELETE FROM tickers WHERE symbol = ?").run(symbol);
    });
  }

  /** Runs `statement` through the write queue, reading `entries` back until it lands. */
  private write(operationName: string, entries: Array<[string, PendingTicker]>, statement: () => void): void {
    for (const [symbol, entry] of entries) this.pending.set(symbol, entry);
    this.access.write(operationName, statement, () => {
      for (const [symbol, entry] of entries) {
        if (this.pending.get(symbol) === entry) this.pending.delete(symbol);
      }
    });
  }
}
