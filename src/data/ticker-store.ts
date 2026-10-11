import type { Database } from "bun:sqlite";
import { serializeJson } from "./sqlite/json";
import { withSqliteBusyRetry } from "./sqlite/retry";

export interface StoredTickerRecord {
  symbol: string;
  metadata: string;
}

export class TickerStore {
  constructor(private readonly db: Database) {}

  getAll(): StoredTickerRecord[] {
    return withSqliteBusyRetry("load tickers", () => (
      this.db
        .query<StoredTickerRecord, []>(
          "SELECT symbol, metadata FROM tickers ORDER BY symbol",
        )
        .all()
    ));
  }

  get(symbol: string): string | null {
    const row = withSqliteBusyRetry("load ticker", () => (
      this.db
        .query<{ metadata: string }, [string]>(
          "SELECT metadata FROM tickers WHERE symbol = ?",
        )
        .get(symbol)
    ));
    return row?.metadata ?? null;
  }

  save(symbol: string, metadata: unknown): void {
    withSqliteBusyRetry("save ticker", () => {
      this.db
        .query(
          `INSERT OR REPLACE INTO tickers (symbol, metadata, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(symbol, serializeJson(metadata), Date.now());
    });
  }

  /** Saves every record in one transaction: one write for a whole import, not one per ticker. */
  saveMany(records: ReadonlyArray<{ symbol: string; metadata: unknown }>): void {
    if (records.length === 0) return;
    withSqliteBusyRetry("save tickers", () => {
      const statement = this.db.query(
        `INSERT OR REPLACE INTO tickers (symbol, metadata, updated_at)
         VALUES (?, ?, ?)`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const record of records) statement.run(record.symbol, serializeJson(record.metadata), now);
      })();
    });
  }

  delete(symbol: string): void {
    withSqliteBusyRetry("delete ticker", () => {
      this.db.query("DELETE FROM tickers WHERE symbol = ?").run(symbol);
    });
  }
}
