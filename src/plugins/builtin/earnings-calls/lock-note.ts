import type { PaneLock } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { proLockNote, type FreeRoute } from "../shared/pro-lock-note";

const EVENTS_ROUTE: FreeRoute = {
  text: (ticker, company) => `gloom events ${ticker} lists ${company}'s earnings dates, with the EPS reported at each and the next estimate.`,
  answers: async (symbol, context) => {
    const { symbol: ticker, exchange } = await resolveHeadlessInstrument(context, symbol);
    return ((await context.marketData.getCorporateActions?.(ticker, exchange))?.earnings.length ?? 0) > 0;
  },
};

/**
 * CALLS is Pro whole, the list of calls included. `events` needs no account
 * and lists a company's earnings dates, each with the EPS it reported and the
 * next one's estimate, without the call or its transcript.
 */
export function callsLockNote(lock: PaneLock): Promise<string> {
  return proLockNote(lock, {
    token: "CALLS",
    argument: "optional",
    does: "it reads each earnings call into a transcript with speaker turns, analyst Q&A and extracted guidance",
    shows: "it",
    free: [EVENTS_ROUTE],
  });
}
