import type { PaneLock } from "../../../types/plugin";
import { proLockNote } from "../shared/pro-lock-note";

/**
 * FLOW is Pro whole: the one scanner with no delayed tier to fall back to.
 * The options chain needs no account and lists each contract's day volume and
 * open interest, the raw counts behind a sweep or a block, without the prints.
 * FLOW takes no ticker, so the route names none to check.
 */
export function flowLockNote(lock: PaneLock): Promise<string> {
  return proLockNote(lock, {
    token: "FLOW",
    argument: "none",
    does: "it streams real-time sweeps, blocks and large premium prints across US options exchanges",
    shows: "it",
    free: [{ text: (ticker, company) => `gloom options ${ticker} lists ${company}'s option chain, each contract with its volume and open interest.` }],
  });
}
