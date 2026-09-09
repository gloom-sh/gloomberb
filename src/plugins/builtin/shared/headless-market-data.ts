import type { HeadlessPaneContext } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";
import { parsePublicTickerKey } from "../../../utils/exchanges";

export async function resolveHeadlessInstrument(ctx: HeadlessPaneContext, symbol: string) {
  return ctx.resolveInstrument ? ctx.resolveInstrument(symbol) : parsePublicTickerKey(symbol);
}

export async function loadHeadlessFinancials(ctx: HeadlessPaneContext, key: string) {
  const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
  return ctx.marketData.getTickerFinancials(symbol, exchange ?? "");
}

export async function loadHeadlessPriceHistory(ctx: HeadlessPaneContext, key: string, range: TimeRange) {
  const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
  return clipPriceHistoryToRange(await ctx.marketData.getPriceHistory(symbol, exchange ?? "", range), range);
}

/** One failed input must not hide the peers that loaded successfully. */
export async function loadHeadlessSymbols<T>(
  symbols: string[],
  ctx: HeadlessPaneContext,
  load: (symbol: string) => Promise<T>,
) {
  const results = await Promise.allSettled(symbols.map(load));
  ctx.signal.throwIfAborted();
  const entries: Array<{ symbol: string; data: T }> = [];
  const unavailableSymbols: string[] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    const symbol = symbols[index]!;
    if (result.status === "fulfilled") entries.push({ symbol, data: result.value });
    else {
      unavailableSymbols.push(symbol);
      errors.push(`${symbol}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  return { entries, unavailableSymbols, errors };
}
