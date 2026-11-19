import type { TickerMetadata, TickerRecord } from "../../../../types/ticker";
import { backendRequest } from "../backend-rpc";
import { runTickerWrite } from "../../../../data/ticker-writes";

export class RemoteTickerRepository {
  async loadAllTickers(): Promise<TickerRecord[]> {
    return backendRequest("ticker.loadAll");
  }

  /** Changes when another program (a `gloom` command, the terminal app) commits to the profile's database. */
  changesElsewhere(): Promise<number | null> {
    return backendRequest("ticker.changesElsewhere");
  }

  /** The rows another program deleted that the backend held, for this window to drop from what it shows. */
  takeRowsDeletedElsewhere(): Promise<string[]> {
    return backendRequest("ticker.takeDeletedElsewhere");
  }

  async loadTicker(symbol: string): Promise<TickerRecord | null> {
    return backendRequest("ticker.load", { symbol });
  }

  saveTicker(ticker: TickerRecord): Promise<void> {
    return runTickerWrite(this, ticker.metadata.ticker, async () => {
      await backendRequest("ticker.save", { ticker });
    });
  }

  createTicker(metadata: TickerMetadata): Promise<TickerRecord> {
    const ticker: TickerRecord = { metadata };
    return runTickerWrite(this, metadata.ticker, async () => {
      await backendRequest("ticker.save", { ticker });
      return ticker;
    });
  }

  deleteTicker(symbol: string): Promise<void> {
    return runTickerWrite(this, symbol, async () => {
      await backendRequest("ticker.delete", { symbol });
    });
  }
}
