import type { TickerRecord } from "../types/ticker";
import { parsePublicTickerKey } from "../utils/exchanges";

/**
 * The listing a typed key stands for in a report (`resolveInstrument`): the
 * venue it names (`SBK:JSE`), else the venue of the ticker saved under the key
 * or under its bare symbol, so a saved `S32` held on the JSE is read there.
 * `fn`, `shot` and the panes that read as they do resolve keys this way.
 */
export async function resolveSavedInstrument(
  key: string,
  loadTicker: (key: string) => Promise<TickerRecord | null | undefined> | TickerRecord | null | undefined,
): Promise<{ symbol: string; exchange?: string }> {
  const parsed = parsePublicTickerKey(key);
  const ticker = await loadTicker(key) ?? (key !== parsed.symbol ? await loadTicker(parsed.symbol) : null);
  return { symbol: parsed.symbol, exchange: parsed.exchange ?? ticker?.metadata.exchange };
}
