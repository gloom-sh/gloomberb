import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  HolderRecord,
  OptionsChain,
  StatementFiling,
  TickerFinancials,
} from "../../types/financials";
import type { CloudQuotePayload } from "./quotes";

export interface CloudFinancialsPayload extends Omit<TickerFinancials, "quote" | "resultsFilings"> {
  quote?: CloudQuotePayload;
  /** Each period's results announcement and report (TickerFinancials.resultsFilings). */
  statementFilings?: StatementFiling[];
}

export interface CloudOptionsChainPayload extends OptionsChain {
  providerId: "gloomberb-cloud";
}

interface CloudHolderPayload extends HolderRecord {
  providerId: "gloomberb-cloud";
  ownerType: "institution";
}

export interface CloudHoldersPayload extends HolderData {
  providerId: "gloomberb-cloud";
  holders: CloudHolderPayload[];
}

export interface CloudAnalystResearchPayload extends AnalystResearchData {
  providerId: "gloomberb-cloud";
}

export interface CloudCorporateActionsPayload extends CorporateActionsData {
  providerId: "gloomberb-cloud";
}

interface CloudShortInterestPointPayload {
  settlementDate: string;
  shortPercentFloat?: number | null;
  /** The 10-K or 10-Q cover share count known when FINRA published the settlement. Absent on servers older than the field. */
  sharesOutstanding?: number;
  /** YYYY-MM-DD that count was taken. */
  sharesOutstandingAsOf?: string;
  sharesShort: number;
  previousSharesShort: number | null;
  averageDailyVolume: number | null;
  daysToCover: number | null;
  changePercent: number | null;
  revised: boolean;
}

export interface CloudShortInterestPayload {
  source?: "finra" | "gloom";
  symbol: string;
  issueName: string | null;
  points: CloudShortInterestPointPayload[];
}
