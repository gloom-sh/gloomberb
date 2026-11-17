import { logFailure } from "../utils/log-failure";
import type { TickerRecord, TickerMetadata } from "../types/ticker";
import type { TickerStore } from "./ticker-store";
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
 * copy of. Each row's copy is kept as it was read or last saved here; a save
 * over a row another program changed since keeps that program's change and
 * adds this one's (see `profile-merge.ts`).
 */
export class TickerRepository {
  /** Each row as this program's copy of it was read or saved, by symbol. */
  private readonly copies = new Map<string, string>();

  constructor(private readonly tickers: TickerStore) {}

  /** Changes when another program commits to the database (see `TickerStore.changesElsewhere`). */
  changesElsewhere(): number | null {
    return this.tickers.changesElsewhere();
  }

  async loadAllTickers(): Promise<TickerRecord[]> {
    return this.tickers.getAll().flatMap((row) => {
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
    if (!json) return null;
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
      this.tickers.save(ticker.metadata.ticker, this.withChangesElsewhere(ticker.metadata));
    });
  }

  /** Saves several tickers in one write. */
  saveTickers(tickers: readonly TickerRecord[]): Promise<void> {
    return runTickerWrite(this, tickers.map((ticker) => ticker.metadata.ticker), () => {
      this.tickers.saveMany(tickers.map((ticker) => ({ symbol: ticker.metadata.ticker, metadata: this.withChangesElsewhere(ticker.metadata) })));
    });
  }

  createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker: TickerRecord = { metadata };
    return runTickerWrite(this, metadata.ticker, () => {
      this.tickers.save(metadata.ticker, this.withChangesElsewhere(metadata));
      return ticker;
    });
  }

  deleteTicker(symbol: string): Promise<void> {
    return runTickerWrite(this, symbol, () => {
      this.tickers.delete(symbol);
      this.copies.delete(symbol);
    });
  }

  /**
   * A row read is what this program's copy of it is built on from now, but
   * not while a save of the row is on its way: that save was built on the
   * copy before, and is compared with that one.
   */
  private noteRead(symbol: string, metadata: string): void {
    if (!hasPendingTickerWrite(this, symbol)) this.copies.set(symbol, metadata);
  }

  /**
   * The row to write for `metadata`, this program's copy: as it is, unless
   * another program changed the stored row since the copy was read, in which
   * case that change is folded in. The copy stays what this program built,
   * so a later save of it folds the same change in again until the program
   * reads the row anew.
   */
  private withChangesElsewhere(metadata: TickerMetadata): unknown {
    const symbol = metadata.ticker;
    const mine = serializeJson(metadata);
    const base = this.copies.get(symbol);
    this.copies.set(symbol, mine);
    if (base === undefined) return metadata;
    const stored = this.tickers.get(symbol);
    if (stored === null || stored === base || stored === mine) return metadata;
    try {
      const edits = diffProfile(JSON.parse(base) as ProfileJson, JSON.parse(stored) as ProfileJson);
      return applyProfileEdits(JSON.parse(mine) as ProfileJson, edits);
    } catch (error) {
      logFailure("data.ticker-repository", "Reading a ticker row another program changed failed")(error);
      return metadata;
    }
  }
}
