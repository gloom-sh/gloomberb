import type { PaneLock } from "../../../types/plugin";
import { proLockNote } from "../shared/pro-lock-note";

/**
 * CALLS is Pro whole, the list of calls included. `events` needs no account
 * and lists a company's earnings dates, each with the EPS it reported and the
 * next one's estimate, without the call or its transcript.
 */
export function callsLockNote(lock: PaneLock): string {
  return proLockNote(lock, {
    token: "CALLS",
    argument: "optional",
    does: "it reads each earnings call into a transcript with speaker turns, analyst Q&A and extracted guidance",
    shows: "it",
    free: (ticker, company) => `gloomberb events ${ticker} lists ${company}'s earnings dates, with the EPS reported at each and the next estimate.`,
  });
}
