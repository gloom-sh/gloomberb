import type { PaneLock } from "../../../types/plugin";
import { proLockNote } from "../shared/pro-lock-note";

/**
 * EM, EEO and GUID read one Gloom Cloud route that asks for a signed-in account
 * with a verified email, and no plan. The report names the function it was run
 * for. GUIDE lists a company's latest guidance ranges, as a free preview;
 * `earnings` lists the next report date with its consensus EPS estimate.
 */
export function estimateRevisionsLockNote(lock: PaneLock): string {
  const guidance = lock.token === "GUID";
  return proLockNote(lock, {
    token: guidance ? "GUID" : "EM",
    needs: "sign-in",
    does: guidance
      ? "it reads the EPS guidance a company issued, cited from its filings and calls, against consensus"
      : "it reads consensus EPS estimates by fiscal period, how they were revised, the surprises against reported EPS and the guidance",
    shows: "it",
    free: guidance
      ? (ticker, company) => `gloomberb fn GUIDE ${ticker} lists ${company}'s latest guidance ranges, with the date each was issued.`
      : (ticker, company) => `gloomberb earnings ${ticker} lists ${company}'s next report date with its consensus EPS estimate.`,
  });
}
