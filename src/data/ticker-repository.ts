import { logFailure } from "../utils/log-failure";
import type { TickerRecord, TickerMetadata } from "../types/ticker";
import type { ResolvedTickerRow, TickerStore } from "./ticker-store";
import { hydrateTickerMetadata } from "../tickers/metadata";
import { hasPendingTickerWrite, runTickerWrite } from "./ticker-writes";
import { serializeJson } from "./sqlite/json";
import { applyProfileEdits, diffProfile, type ProfileJson } from "./profile-merge";

function parseTickerMetadata(json: string): TickerMetadata {
  return hydrateTickerMetadata(JSON.parse(json) as Record<string, unknown>);
}

/**
 * Ticker rows are shared like config.json: a `gloom watchlist add` or
 * `portfolio position set` run beside the app writes the row the app holds a
 * copy of, and another copy of the app (the desktop app beside the terminal
 * one) can delete a row in its cleanup. Each row's copy is kept as it was read
 * or last saved here. A save over a row another program changed since keeps
 * that program's change and adds this one's (see `profile-merge.ts`); a save
 * over a row another program deleted since leaves it deleted, as a removal
 * always lands. Which of those it is gets decided in the write's own
 * transaction, when it lands (`TickerStore.saveResolved`).
 */
export class TickerRepository {
  /**
   * Each row as this program's copy of it was read or last saved, by symbol:
   * what the next save of it is compared with. Only a write that landed moves
   * it, never one still queued or dropped for a later write of the same row.
   */
  private readonly copies = new Map<string, string>();
  /**
   * Rows this program holds a copy of that a read of every row found gone:
   * another program deleted them. Their copies stay, so a save of the app's
   * copy still leaves them deleted, until the app has dropped them from what
   * it shows (`takeRowsDeletedElsewhere`) and lets them go.
   */
  private readonly goneElsewhere = new Set<string>();

  constructor(private readonly tickers: TickerStore) {}

  /** Changes when another program commits to the database (see `TickerStore.changesElsewhere`). */
  changesElsewhere(): number | null {
    return this.tickers.changesElsewhere();
  }

  async loadAllTickers(): Promise<TickerRecord[]> {
    const rows = this.tickers.getAll();
    // A row this program holds a copy of that is gone was deleted elsewhere, whoever wrote it last.
    const present = new Set(rows.map((row) => row.symbol));
    for (const symbol of this.copies.keys()) {
      if (!present.has(symbol) && !this.writing(symbol)) this.goneElsewhere.add(symbol);
    }
    return rows.flatMap((row) => {
      try {
        const record = { metadata: parseTickerMetadata(row.metadata) };
        this.noteRead(row.symbol, row.metadata);
        return [record];
      } catch (error) {
        logFailure("data.ticker-repository", "Reading stored ticker metadata failed")(error);
        return [];
      }
    });
  }

  async loadTicker(symbol: string): Promise<TickerRecord | null> {
    const json = this.tickers.get(symbol);
    if (!json) {
      this.noteRead(symbol, null);
      return null;
    }
    try {
      const record = { metadata: parseTickerMetadata(json) };
      this.noteRead(symbol, json);
      return record;
    } catch (error) {
      logFailure("data.ticker-repository", "Reading stored ticker metadata failed")(error);
      return null;
    }
  }

  saveTicker(ticker: TickerRecord): Promise<void> {
    return runTickerWrite(this, ticker.metadata.ticker, () => {
      this.tickers.saveResolved([this.rowToSave(ticker.metadata)]);
    });
  }

  /** Saves several tickers in one write. */
  saveTickers(tickers: readonly TickerRecord[]): Promise<void> {
    return runTickerWrite(this, tickers.map((ticker) => ticker.metadata.ticker), () => {
      this.tickers.saveResolved(tickers.map((ticker) => this.rowToSave(ticker.metadata)));
    });
  }

  createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker: TickerRecord = { metadata };
    return runTickerWrite(this, metadata.ticker, () => {
      this.tickers.saveResolved([this.rowToSave(metadata)]);
      return ticker;
    });
  }

  deleteTicker(symbol: string): Promise<void> {
    return runTickerWrite(this, symbol, () => {
      this.tickers.delete(symbol);
      this.copies.delete(symbol);
      this.goneElsewhere.delete(symbol);
    });
  }

  /**
   * The rows another program deleted that this program held, as reads of
   * every row found them gone since the last call, for the app to drop from
   * what it shows; their copies go with them, so a ticker added again after
   * is a new row. A row with a save of it on its way is kept for a later
   * call: that save is still compared with its copy.
   */
  takeRowsDeletedElsewhere(): string[] {
    const taken = [...this.goneElsewhere].filter((symbol) => !this.writing(symbol));
    for (const symbol of taken) {
      this.goneElsewhere.delete(symbol);
      this.copies.delete(symbol);
    }
    return taken;
  }

  /** Whether a save of `symbol` is on its way, or waits behind another program's lock. */
  private writing(symbol: string): boolean {
    return hasPendingTickerWrite(this, symbol) || this.tickers.isQueued(symbol);
  }

  /**
   * A row read is what this program's copy of it is built on from now (null:
   * there is none, so the next save writes a new row), but not while a save
   * of the row is on its way or waits behind another program's lock: that
   * save was built on the copy before, and is compared with that one, and
   * what the read sees of the row is that save's own.
   */
  private noteRead(symbol: string, metadata: string | null): void {
    if (this.writing(symbol)) return;
    this.goneElsewhere.delete(symbol);
    if (metadata === null) this.copies.delete(symbol);
    else this.copies.set(symbol, metadata);
  }

  /**
   * `metadata`, this program's copy, as a row the store resolves when the
   * write lands, against the copy it was built on (`copies`, as it stands
   * then):
   * - no copy: a row this program has not read, written as it is;
   * - the stored row is gone: another program deleted it since, and it stays
   *   deleted until the app has dropped it (`takeRowsDeletedElsewhere`) or
   *   reads that one row anew (`loadTicker`);
   * - the stored row is the copy, or this very row: written as it is;
   * - otherwise another program changed it, and that change is folded in.
   * Once written, the copy is what this program built, so a later save of a
   * copy that never read the change folds it in again.
   */
  private rowToSave(metadata: TickerMetadata): ResolvedTickerRow {
    const symbol = metadata.ticker;
    const mine = serializeJson(metadata);
    return {
      symbol,
      preview: metadata,
      resolve: (stored) => {
        const base = this.copies.get(symbol);
        if (base === undefined) return metadata;
        if (stored === null) return null;
        if (stored === base || stored === mine) return metadata;
        try {
          const edits = diffProfile(JSON.parse(base) as ProfileJson, JSON.parse(stored) as ProfileJson);
          return applyProfileEdits(JSON.parse(mine) as ProfileJson, edits);
        } catch (error) {
          logFailure("data.ticker-repository", "Reading a ticker row another program changed failed")(error);
          return metadata;
        }
      },
      landed: (written) => {
        if (written === null) return;
        this.copies.set(symbol, mine);
        this.goneElsewhere.delete(symbol);
      },
    };
  }
}
