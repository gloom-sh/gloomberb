import type { TickerRepository } from "../data/ticker-repository";
import type { TickerMetadata, TickerRecord } from "../types/ticker";

export type TickerSource = Pick<TickerRepository, "loadTicker" | "loadAllTickers" | "saveTicker"> & Partial<Pick<TickerRepository, "saveTickers">>;

/**
 * A ticker store that keeps a command's changes in memory until `commit`,
 * which saves them in one write. A command that adds hundreds of symbols reads
 * its own changes back while it works and writes once at the end, so the app
 * sharing the database is never held up by a write per symbol.
 */
export class StagedTickerRepository {
  private readonly staged = new Map<string, TickerRecord>();
  private saved: Promise<TickerRecord[]> | null = null;

  constructor(private readonly base: TickerSource) {}

  async loadTicker(symbol: string): Promise<TickerRecord | null> {
    return this.staged.get(symbol) ?? await this.base.loadTicker(symbol);
  }

  async loadAllTickers(): Promise<TickerRecord[]> {
    this.saved ??= this.base.loadAllTickers();
    const merged = new Map((await this.saved).map((ticker) => [ticker.metadata.ticker, ticker] as const));
    for (const [symbol, ticker] of this.staged) merged.set(symbol, ticker);
    return [...merged.values()];
  }

  async saveTicker(ticker: TickerRecord): Promise<void> {
    this.staged.set(ticker.metadata.ticker, ticker);
  }

  async createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker: TickerRecord = { metadata };
    await this.saveTicker(ticker);
    return ticker;
  }

  /** Drops what the command staged for a ticker, so the commit leaves it as it was. */
  discard(symbol: string): void {
    this.staged.delete(symbol);
  }

  async deleteTicker(): Promise<void> {
    throw new Error("A staged ticker store does not delete tickers.");
  }

  /** Writes every staged ticker at once. */
  async commit(): Promise<void> {
    const tickers = [...this.staged.values()];
    if (tickers.length === 0) return;
    if (this.base.saveTickers) await this.base.saveTickers(tickers);
    else for (const ticker of tickers) await this.base.saveTicker(ticker);
    this.staged.clear();
    this.saved = null;
  }
}
