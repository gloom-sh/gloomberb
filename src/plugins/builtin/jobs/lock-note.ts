import type { PaneLock } from "../../../types/plugin";
import { proLockNote } from "../shared/pro-lock-note";

/**
 * JOBS is Pro whole. HIRE reads the same careers systems and needs no
 * account: a company's latest roles, without the full history.
 */
export function jobsLockNote(lock: PaneLock): string {
  return proLockNote(lock, {
    token: "JOBS",
    argument: "optional",
    does: "it reads each company's careers system into open roles, hiring pace and the mix by function and country",
    shows: "it",
    free: (ticker, company) => `gloomberb fn HIRE ${ticker} previews ${company}'s hiring with its latest roles, without the full history.`,
  });
}
