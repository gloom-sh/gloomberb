import type { TickerMetadata, TickerRecord } from "../../../../types/ticker";
import { backendRequest } from "../backend-rpc";

export class RemoteTickerRepository {
  async loadAllTickers(): Promise<TickerRecord[]> {
    return backendRequest("ticker.loadAll");
  }

  async loadTicker(symbol: string): Promise<TickerRecord | null> {
    return backendRequest("ticker.load", { symbol });
  }

  async saveTicker(ticker: TickerRecord): Promise<void> {
    await backendRequest("ticker.save", { ticker });
  }

  async createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker: TickerRecord = { metadata };
    await this.saveTicker(ticker);
    return ticker;
  }

  async deleteTicker(symbol: string): Promise<void> {
    await backendRequest("ticker.delete", { symbol });
  }
}
