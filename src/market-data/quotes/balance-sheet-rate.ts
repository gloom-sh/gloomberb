import { apiClient } from "../../api-client";
import type { BalanceSheetRate, TickerFinancials } from "../../types/financials";
import { settleWithin } from "../../utils/async-deadline";
import { dailyFxLeg, fxCloseOnDate, type FxCloseReading, type FxHistoryClient } from "../fx-closes";
import { balanceSheetRateWanted } from "./listing-enterprise-value";

/** How long a report waits for the two daily closes; without them the EV says which close it needs. */
const BALANCE_SHEET_RATE_BUDGET_MS = 2_500;

/** USD per unit at the close on or before `date`: 1 for the dollar, null without a close that week. */
async function usdClose(currency: string, date: string, client: FxHistoryClient): Promise<FxCloseReading | null> {
  if (currency === "USD") return { rate: 1, date };
  const leg = dailyFxLeg(currency);
  return leg ? fxCloseOnDate(leg, date, client) : null;
}

/**
 * The financials with the close their EV bridge wants (balanceSheetRateWanted):
 * a balance sheet in another currency than the market cap, at our daily
 * closes on its date crossed through the dollar, dated by the older of the
 * two. As they were where no rate is wanted, or none was read within 2.5 s.
 */
export async function withBalanceSheetRate<T extends TickerFinancials>(financials: T, client: FxHistoryClient = apiClient): Promise<T> {
  const wanted = balanceSheetRateWanted(financials);
  if (!wanted) return financials;
  const read = async (): Promise<BalanceSheetRate | null> => {
    const [from, to] = await Promise.all([usdClose(wanted.from, wanted.date, client), usdClose(wanted.to, wanted.date, client)]);
    if (!from || !to || !(from.rate > 0) || !(to.rate > 0)) return null;
    const closeDate = from.date < to.date ? from.date : to.date;
    return { ...wanted, rate: from.rate / to.rate, closeDate };
  };
  const rate = await settleWithin(read(), BALANCE_SHEET_RATE_BUDGET_MS);
  return rate ? { ...financials, balanceSheetRate: rate } : financials;
}
