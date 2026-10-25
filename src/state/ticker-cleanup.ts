import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { hasPendingTickerWrites, settleTickerWrites, tickerWriteRevision } from "../data/ticker-writes";
import type { TickerRecord } from "../types/ticker";

/**
 * Persist cleanup before publishing it, retrying against edits acknowledged in between.
 * Return the cleaned map so callers can recheck it after their config save.
 */
export async function persistTickerCleanup({
  tickerRepository,
  getTickers,
  transform,
  publish,
  isCurrent = () => true,
}: {
  tickerRepository: AppTickerRepositoryPort;
  getTickers: () => ReadonlyMap<string, TickerRecord>;
  transform: (ticker: TickerRecord) => TickerRecord | null;
  publish: (symbol: string, ticker: TickerRecord | null) => void;
  isCurrent?: () => boolean;
}): Promise<ReadonlyMap<string, TickerRecord> | null> {
  for (;;) {
    do {
      await settleTickerWrites(tickerRepository);
    } while (hasPendingTickerWrites(tickerRepository));
    if (!isCurrent()) return null;
    const before = getTickers();
    let wrote = false;
    for (const symbol of before.keys()) {
      do {
        await settleTickerWrites(tickerRepository);
      } while (hasPendingTickerWrites(tickerRepository));
      if (!isCurrent()) return null;
      const source = getTickers().get(symbol);
      if (!source) continue;
      const next = transform(source);
      if (next === source) continue;
      wrote = true;
      const save = next ? tickerRepository.saveTicker(next) : tickerRepository.deleteTicker(symbol);
      const revision = tickerWriteRevision(tickerRepository, symbol);
      await save;
      if (!isCurrent()) return null;
      // An edit can start its save before publishing state, especially over RPC.
      if (tickerWriteRevision(tickerRepository, symbol) !== revision || getTickers().get(symbol) !== source) continue;
      publish(symbol, next);
    }
    // Include rows created or recreated while earlier rows were being saved.
    if (!wrote && getTickers() === before) return before;
  }
}
