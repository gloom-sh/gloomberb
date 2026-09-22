import type { TapeSnapshot } from "../../../api-client/tape";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";
import { validateTape } from "./client";
import type { TapeClient } from "./use-tape";

export type TapeCapture = readonly [symbol: string, exchange: string, snapshot: TapeSnapshot];
const key = (symbol: string, exchange: string) => `${canonicalExchange(exchange)}:${normalizeSymbol(symbol)}`;

/** A captured pane has one dated bootstrap and no browser-owned live socket. */
export function createSnapshotTapeClient(
  captures: readonly TapeCapture[],
  bootstrap: (symbol: string, exchange: string) => Promise<TapeSnapshot>,
): TapeClient {
  const snapshots = new Map(captures.map(([symbol, exchange, data]) => [key(symbol, exchange), validateTape(data, symbol, exchange)]));
  return {
    snapshotOnly: true,
    async getCloudTape(symbol, exchange, signal) {
      signal?.throwIfAborted();
      const cached = snapshots.get(key(symbol, exchange));
      const result = cached ?? validateTape(await bootstrap(symbol, exchange), symbol, exchange);
      signal?.throwIfAborted();
      return result;
    },
    // HTTP bootstrap is authoritative for a still image. Socket resets would
    // discard it or race the screenshot's readiness signal.
    subscribeTape: () => () => {},
  };
}
