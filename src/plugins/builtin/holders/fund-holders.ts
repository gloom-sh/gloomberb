import type { Quote } from "../../../types/financials";
import { quoteTradingExchange } from "../../../market-data/quotes/metadata";
import { isUsListingExchange } from "../../../utils/exchanges";
import { isFundType } from "../../../utils/sec";
import { isNoSourceAnswer } from "../../../sources/provider-errors";
import { logFailure } from "../../../utils/log-failure";
import { fetchFunds } from "../members/client";
import { coveredFund } from "../members/model";

type FundQuote = Pick<Quote, "instrumentType" | "tradingExchangeName" | "listingExchangeName" | "exchangeName">;

/** What a holder report says for a fund in place of its holders: the reason, and the commands that read the fund. */
export interface FundHoldersAnswer {
  message: string;
  /** One command a line, each for what it reads; empty for a fund abroad, which those do not cover. */
  details: string[];
}

/**
 * What `holders`, `13f` and `fn HDS` say for a fund no holder source has an
 * ownership breakdown of (XLE, SPY, EWJ), in place of the source's bare
 * NO_DATA: that it is a fund, and for a US-listed one the commands that read
 * it, each only where it runs: the 13F filers that hold it (`fn 13F`), what it
 * holds where `fn MEMB` covers it, and its fund facts (`fn ETF`). Null for a
 * listing that is not a fund, or a failure that is no answer (a timeout).
 */
export async function fundHoldersAnswer(
  symbol: string,
  error: unknown,
  quote: FundQuote | null | undefined,
  client: NonNullable<Parameters<typeof fetchFunds>[0]>,
): Promise<FundHoldersAnswer | null> {
  if (!isNoSourceAnswer(error) || !quote || !isFundType(quote.instrumentType)) return null;
  const fund = symbol.split(":")[0]!.trim().toUpperCase();
  const message = `${fund} is a fund: there is no ownership breakdown for funds.`;
  if (!isUsListingExchange(quoteTradingExchange(quote))) return { message, details: [] };
  // A covered-fund list that cannot be read names no fn MEMB, which may not run for this fund.
  const funds = await fetchFunds(client).then((payload) => payload.funds)
    .catch(logFailure("holders.fund-holders", "Read the funds fn MEMB covers failed", null));
  const covered = !!funds && !!coveredFund(funds, fund);
  // Shares of an exchange-traded fund are 13F securities; a mutual fund's are not.
  const traded = !/MUTUAL/i.test(quote.instrumentType ?? "");
  return {
    message,
    details: [
      ...traded ? [`13F filers that hold it: gloom fn 13F ${fund}`] : [],
      ...covered ? [`What it holds: gloom fn MEMB ${fund}`] : [],
      `Fund facts: gloom fn ETF ${fund}`,
    ],
  };
}
