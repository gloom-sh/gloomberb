import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { hydrateTickerMetadata } from "../../tickers/metadata";
import type { TickerMetadata, TickerRecord } from "../../types/ticker";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./storage";

type StoredTickers = Record<string, TickerMetadata>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function hydrate(metadata: TickerMetadata): TickerRecord | null {
  try {
    return { metadata: hydrateTickerMetadata(metadata as unknown as Record<string, unknown>) };
  } catch {
    return null;
  }
}

export class BrowserTickerRepository implements AppTickerRepositoryPort {
  private readonly data: SafeJsonStorage<StoredTickers>;

  constructor(storage: StorageLike) {
    this.data = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.tickers, {}, (value): value is StoredTickers => isRecord(value));
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

  async saveTicker(ticker: TickerRecord): Promise<void> {
    const symbol = normalizeSymbol(ticker.metadata.ticker);
    this.data.set({ ...this.data.get(), [symbol]: ticker.metadata });
  }

  async createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker = { metadata };
    await this.saveTicker(ticker);
    return ticker;
  }

  async deleteTicker(symbol: string): Promise<void> {
    const tickers = { ...this.data.get() };
    delete tickers[normalizeSymbol(symbol)];
    this.data.set(tickers);
  }
}
