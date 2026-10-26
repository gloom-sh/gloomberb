import { logFailure } from "../utils/log-failure";
import type { TickerRecord, TickerMetadata } from "../types/ticker";
import type { TickerStore } from "./ticker-store";
import { hydrateTickerMetadata } from "../tickers/metadata";
import { runTickerWrite } from "./ticker-writes";

function parseTickerMetadata(json: string): TickerMetadata {
  return hydrateTickerMetadata(JSON.parse(json) as Record<string, unknown>);
}

export class TickerRepository {
  constructor(private readonly tickers: TickerStore) {}

  async loadAllTickers(): Promise<TickerRecord[]> {
    return this.tickers.getAll().flatMap((row) => {
      try {
        return [{ metadata: parseTickerMetadata(row.metadata) }];
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
      return { metadata: parseTickerMetadata(json) };
    } catch (error) {
      logFailure("data.ticker-repository", "Reading stored ticker metadata failed")(error);
      return null;
    }
  }

  saveTicker(ticker: TickerRecord): Promise<void> {
    return runTickerWrite(this, ticker.metadata.ticker, () => {
      this.tickers.save(ticker.metadata.ticker, ticker.metadata);
    });
  }

  /** Saves several tickers in one write. */
  saveTickers(tickers: readonly TickerRecord[]): Promise<void> {
    return runTickerWrite(this, tickers.map((ticker) => ticker.metadata.ticker), () => {
      this.tickers.saveMany(tickers.map((ticker) => ({ symbol: ticker.metadata.ticker, metadata: ticker.metadata })));
    });
  }

  createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker: TickerRecord = { metadata };
    return runTickerWrite(this, metadata.ticker, () => {
      this.tickers.save(metadata.ticker, metadata);
      return ticker;
    });
  }

  deleteTicker(symbol: string): Promise<void> {
    return runTickerWrite(this, symbol, () => this.tickers.delete(symbol));
  }
}
