import type { PaneLock } from "../../../types/plugin";
import { fetchCompanyData } from "../company-kpis/client";
import { filesForm } from "../shared/free-routes";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import { proLockNote, type FreeRoute } from "../shared/pro-lock-note";

/** GUIDE's free preview, where it holds guidance for the company: Apple issues none, so GUIDE has no AAPL rows. */
const GUIDE_ROUTE: FreeRoute = {
  text: (ticker, company) => `gloomberb fn GUIDE ${ticker} lists ${company}'s latest guidance ranges, with the date each was issued.`,
  answers: async (symbol, context) => {
    const data = await fetchCompanyData("guidance", symbol, {}, context.apiClient, await resolveHeadlessIssuerListing(context, symbol));
    return "guidance" in data && data.guidance.length + data.history.length > 0;
  },
};

/** The company's 8-Ks, where results and any guidance it gives are filed, for a company that files them. */
const EIGHT_K_ROUTE: FreeRoute = {
  text: (ticker, company) => `gloomberb filings ${ticker} --form 8-K lists ${company}'s 8-Ks, where it files its results and any guidance, each with its items and a link to the filing.`,
  answers: (symbol, context) => filesForm(symbol, "8-K", context),
};

const EARNINGS_ROUTE: FreeRoute = {
  text: (ticker, company) => `gloomberb earnings ${ticker} lists ${company}'s next report date with its consensus EPS estimate.`,
  answers: async (symbol, context) => (await context.marketData.getEarningsCalendar?.([symbol]) ?? []).length > 0,
};

/**
 * EM, EEO and GUID read one Gloom Cloud route that asks for a signed-in account
 * with a verified email, and no plan. The report names the function it was run
 * for. GUIDE lists a company's latest guidance ranges, as a free preview, and
 * its 8-Ks hold what GUIDE does not cover; `earnings` lists the next report
 * date with its consensus EPS estimate.
 */
export function estimateRevisionsLockNote(lock: PaneLock): Promise<string> {
  const guidance = lock.token === "GUID";
  return proLockNote(lock, {
    token: guidance ? "GUID" : "EM",
    needs: "sign-in",
    does: guidance
      ? "it reads the EPS guidance a company issued, cited from its filings and calls, against consensus"
      : "it reads consensus EPS estimates by fiscal period, how they were revised, the surprises against reported EPS and the guidance",
    shows: "it",
    free: guidance ? [GUIDE_ROUTE, EIGHT_K_ROUTE] : [EARNINGS_ROUTE],
  });
}
