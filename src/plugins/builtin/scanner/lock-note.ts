import type { PaneLock } from "../../../types/plugin";
import { isOptionsUnavailableError } from "../../../market-data/options-alternatives";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { proLockNote, type FreeRoute } from "../shared/pro-lock-note";

/**
 * The listing's option chain, which needs no account, where options are
 * served for it: LHA:XETRA has none, and `options LHA:XETRA` says so.
 */
const OPTIONS_ROUTE: FreeRoute = {
  text: (ticker, company) => `gloom options ${ticker} lists ${company}'s option chain, each contract with its volume and open interest.`,
  answers: async (symbol, context) => {
    const { symbol: ticker, exchange } = await resolveHeadlessInstrument(context, symbol);
    if (!context.marketData.getOptionsChain) return false;
    try {
      const chain = await context.marketData.getOptionsChain(ticker, exchange ?? "");
      return chain.expirationDates.length + chain.calls.length + chain.puts.length > 0;
    } catch (error) {
      if (isOptionsUnavailableError(error)) return false;
      throw error;
    }
  },
};

/**
 * FLOW is Pro whole: the one scanner with no delayed tier to fall back to.
 * The options chain needs no account and lists each contract's day volume and
 * open interest, the raw counts behind a sweep or a block, without the prints.
 * FLOW takes a ticker only to narrow the market to one name, so the note
 * repeats it only when the reader gave one, and only when the listing has
 * options served: FLOW's prints are of the same US options.
 */
export function flowLockNote(lock: PaneLock): Promise<string> {
  return proLockNote(lock, {
    token: "FLOW",
    argument: "optional",
    does: "it streams real-time sweeps, blocks and large premium prints across US options exchanges",
    shows: "it",
    free: [OPTIONS_ROUTE],
    noneFor: (ticker) => `Options are not available for ${ticker}, so FLOW has no prints of it.`,
  });
}
