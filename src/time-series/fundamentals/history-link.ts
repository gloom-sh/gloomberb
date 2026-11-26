import type { TickerFinancials } from "../../types/financials";
import { settleWithin } from "../../utils/async-deadline";
import { HISTORY_LINK_PERIODS, oldestPeriod } from "../../utils/financial-statements";
import { logFailure } from "../../utils/log-failure";
import { extractFundamentalSeries } from "./series";

/** Check the exact metric and last 40 periods the linked GF command will show, not just the dates of statement rows. */
export async function hasEarlierGfRevenue(
  loadExtended: () => Promise<TickerFinancials>,
  period: "annual" | "quarterly",
  dates: readonly string[],
  waitMs = 3_000,
): Promise<boolean | null> {
  const oldest = oldestPeriod(dates);
  if (!oldest) return null;
  const extended = await settleWithin(Promise.resolve().then(loadExtended)
    .catch(logFailure("financials.history-link", "Reading the extended statement history failed", null)), waitMs);
  if (!extended || extended.statementHistory?.status === "retryable-failure") return null;
  const points = extractFundamentalSeries(extended, {
    kind: "security", instrument: { symbol: "" },
    fieldId: "fundamental.totalRevenue", period, timestampMode: "period-end",
  });
  return points.slice(-HISTORY_LINK_PERIODS).some((point) => point.value !== null && Number.isFinite(point.value)
    && point.observedAt.toISOString().slice(0, 10) < oldest);
}
