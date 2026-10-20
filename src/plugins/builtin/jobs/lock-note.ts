import type { PaneLock } from "../../../types/plugin";
import type { HiringPayload } from "../../../api-client/hiring";
import { fetchAttention } from "../company-attention/client";
import { proLockNote, type FreeRoute } from "../shared/pro-lock-note";

/** HIRE's preview, for a company whose careers system it reads: Coffee Holding (JVA) is mapped but uncovered. */
const HIRE_ROUTE: FreeRoute = {
  text: (ticker, company) => `gloomberb fn HIRE ${ticker} previews ${company}'s hiring with its latest roles, without the full history.`,
  answers: async (symbol, context) => {
    const data = await fetchAttention("hiring", symbol, { limit: 1 }, context.apiClient, context.signal) as HiringPayload;
    return data.evidence.length + data.series.length + data.functions.length > 0;
  },
};

/**
 * JOBS is Pro whole. HIRE reads the same careers systems and needs no
 * account: a company's latest roles, without the full history.
 */
export function jobsLockNote(lock: PaneLock): Promise<string> {
  return proLockNote(lock, {
    token: "JOBS",
    argument: "optional",
    does: "it reads each company's careers system into open roles, hiring pace and the mix by function and country",
    shows: "it",
    free: [HIRE_ROUTE],
  });
}
