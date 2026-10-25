import { logFailure } from "../utils/log-failure";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { hydrateTickerMetadata } from "../tickers/metadata";
import type { TickerMetadata, TickerRecord } from "../types/ticker";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./json-storage";
import { isRecord } from "../utils/guards";
import { runTickerWrite } from "./ticker-writes";

type StoredTickers = Record<string, TickerMetadata>;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function hydrate(metadata: TickerMetadata): TickerRecord | null {
  try {
    return { metadata: hydrateTickerMetadata(metadata as unknown as Record<string, unknown>) };
  } catch (error) {
    logFailure("data.json-ticker-repository", "Hydrating a stored ticker failed")(error);
    return null;
  }
}

export class JsonTickerRepository implements AppTickerRepositoryPort {
  private readonly data: SafeJsonStorage<StoredTickers>;

  constructor(storage?: StorageLike, tickers: readonly TickerRecord[] = []) {
    this.data = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.tickers, Object.fromEntries(tickers.map((ticker) => [normalizeSymbol(ticker.metadata.ticker), ticker.metadata])), (value): value is StoredTickers => isRecord(value));
  }

  async loadAllTickers(): Promise<TickerRecord[]> {
    return Object.values(this.data.get()).flatMap((metadata) => {
      const ticker = hydrate(metadata);
      return ticker ? [ticker] : [];
    });
  }

  async loadTicker(symbol: string): Promise<TickerRecord | null> {
    const metadata = this.data.get()[normalizeSymbol(symbol)];
    return metadata ? hydrate(metadata) : null;
  }

  private writeTicker(ticker: TickerRecord): void {
    const symbol = normalizeSymbol(ticker.metadata.ticker);
    this.data.set({ ...this.data.get(), [symbol]: ticker.metadata });
  }

  saveTicker(ticker: TickerRecord): Promise<void> {
    return runTickerWrite(this, ticker.metadata.ticker, () => this.writeTicker(ticker));
  }

  createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker = { metadata };
    return runTickerWrite(this, metadata.ticker, () => {
      this.writeTicker(ticker);
      return ticker;
    });
  }

  deleteTicker(symbol: string): Promise<void> {
    return runTickerWrite(this, symbol, () => {
      const tickers = { ...this.data.get() };
      delete tickers[normalizeSymbol(symbol)];
      this.data.set(tickers);
    });
  }
}
