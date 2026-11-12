import { isNoDataAnswer } from "../../../sources/provider-errors";
import { hasAnalystResearchValue } from "../../../sources/provider-router/financials";
import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { AnalystResearchData } from "../../../types/financials";

/**
 * The listing's analyst research. A listing no analyst covers (CENN) is
 * answered with research that holds nothing, which `hasAnalystCoverage`
 * reads, not with a failure: the service answered it has nothing for a
 * symbol it knows. A symbol it does not know, and a source that did not
 * answer, still fail.
 */
export async function loadAnalystResearch(
  provider: DataProvider,
  symbol: string,
  exchange = "",
  context?: MarketDataRequestContext,
): Promise<AnalystResearchData> {
  if (!provider.getAnalystResearch) throw new Error("Analyst data unavailable");
  try {
    return await provider.getAnalystResearch(symbol, exchange, context);
  } catch (error) {
    if (!isNoDataAnswer(error)) throw error;
    return { symbol, recommendations: [], ratings: [], earningsEstimates: [], revenueEstimates: [] };
  }
}

/** Whether any analyst covers the listing: a target, a rating mix, an action or an estimate. */
export function hasAnalystCoverage(data: AnalystResearchData | null | undefined): boolean {
  return !!data && hasAnalystResearchValue(data);
}

/** What a pane or a report says for a listing no analyst covers. */
export function noAnalystCoverageText(symbol: string): string {
  return `No analyst coverage for ${symbol}.`;
}
