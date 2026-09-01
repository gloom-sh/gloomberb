import type { Contract, IBApiNext } from "@stoqey/ib";
import type { TimeRange } from "../../../time-series/range";
import type { Quote, PricePoint, TickerFinancials } from "../../../types/financials";
import type { BrokerContractRef } from "../../../types/instrument";
import { parseFinStatements, parseReportSnapshot } from "../fundamental-parser";
import { IBKR_DATA_TIMEOUT, withTimeout } from "./timeouts";

export interface IbkrTickerFinancialsContext {
  resolveContract(ticker: string, exchange: string, instrument: BrokerContractRef | null): Promise<Contract>;
  getQuote(
    ticker: string,
    exchange: string,
    instrument?: BrokerContractRef | null,
  ): Promise<Quote>;
  getPriceHistory(
    ticker: string,
    exchange: string,
    range: TimeRange,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]>;
  fetchFundamentalData(contract: Contract, reportType: string): Promise<string | null>;
}

export async function fetchIbkrFundamentalData(
  api: IBApiNext,
  contract: Contract,
  reportType: string,
): Promise<string | null> {
  try {
    return await withTimeout(
      api.getFundamentalData(contract, reportType),
      IBKR_DATA_TIMEOUT,
      `getFundamentalData(${reportType})`,
    );
  } catch {
    return null; // Paper account or no Reuters subscription; source fallback handles it.
  }
}

export async function loadIbkrTickerFinancials(
  context: IbkrTickerFinancialsContext,
  {
    ticker,
    exchange,
    instrument,
  }: {
    ticker: string;
    exchange: string;
    instrument?: BrokerContractRef | null;
  },
): Promise<TickerFinancials> {
  const contract = await withTimeout(
    context.resolveContract(ticker, exchange, instrument ?? null),
    IBKR_DATA_TIMEOUT,
    "resolveContract",
  );

  const [quote, priceHistory, snapshotXml, statementsXml] = await Promise.all([
    context.getQuote(ticker, exchange, instrument),
    context.getPriceHistory(ticker, exchange, "1Y", instrument),
    context.fetchFundamentalData(contract, "ReportSnapshot"),
    context.fetchFundamentalData(contract, "ReportsFinStatements"),
  ]);

  const fundamentals = snapshotXml ? parseReportSnapshot(snapshotXml) : {};
  const statements = statementsXml ? parseFinStatements(statementsXml) : { annual: [], quarterly: [] };

  if (priceHistory.length >= 2) {
    const oldest = priceHistory[0]!.close;
    const newest = priceHistory[priceHistory.length - 1]!.close;
    if (oldest > 0) {
      fundamentals.return1Y = (newest - oldest) / oldest;
    }
  }

  return {
    quote,
    fundamentals,
    annualStatements: statements.annual,
    quarterlyStatements: statements.quarterly,
    priceHistory,
  };
}
