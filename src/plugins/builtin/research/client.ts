import { isNoDataAnswer } from "../../../sources/provider-errors";
import { hasAnalystResearchValue } from "../../../sources/provider-router/financials";
import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { AnalystResearchData } from "../../../types/financials";
import { isUsEquityExchange, typedExchangeCode } from "../../../utils/exchanges";

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

/**
 * Why a covered listing lists no analyst actions. The source keeps each
 * listing's whole history of upgrades, downgrades and target changes, for
 * North American listings: one abroad (VOW3:XETRA, SAP:XETRA, HSBA:LSE) has
 * its targets and rating mix but none of them.
 */
export function noAnalystActionsText(symbol: string, exchange = ""): string {
  const venue = typedExchangeCode(symbol) || exchange;
  return venue && !isUsEquityExchange(venue)
    ? `No upgrades, downgrades or target changes for ${symbol}: the source lists them mainly for North American listings. The targets and rating mix above are current.`
    : `No upgrades, downgrades or target changes on record for ${symbol}.`;
}
