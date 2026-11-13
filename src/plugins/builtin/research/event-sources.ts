import type { DataProvider } from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import { formatEventMetric } from "./event-model";
import { loadAnalystResearch } from "./client";
import { formatPercent, formatPercentRaw } from "../../../utils/format";
import { loadEarningsCalendar } from "../earnings/data/cache";
import { calendarEventOf, listingDay, withResolvedEarnings } from "../shared/earnings-calendar";
import { parsePublicTickerKey } from "../../../utils/exchanges";

function metricFormat(currencyKey: "epsCurrency" | "revenueCurrency", kind: "eps" | "revenue") {
  return (value: unknown, row: Record<string, unknown>) => {
    const currency = row[currencyKey];
    return formatEventMetric(value == null ? undefined : Number(value), typeof currency === "string" ? currency : undefined, kind);
  };
}

/** The columns of both event reports, corporate actions and earnings estimates. */
export const EVENT_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "status", header: "Event" },
  { key: "period", header: "Period" },
  { key: "qEps", header: "Q EPS", align: "right" as const, format: metricFormat("epsCurrency", "eps") },
  { key: "qRevenue", header: "Q revenue", align: "right" as const, format: metricFormat("revenueCurrency", "revenue") },
  { key: "annualEps", header: "Annual EPS", align: "right" as const, format: metricFormat("epsCurrency", "eps") },
  { key: "annualRevenue", header: "Annual revenue", align: "right" as const, format: metricFormat("revenueCurrency", "revenue") },
  { key: "value", header: "Value", align: "right" as const },
  { key: "detail", header: "Detail" },
];

/**
 * The columns of the earnings estimates report, as its pane heads them: what corporate actions
 * call Value is a reported quarter's EPS surprise or an estimate's growth over the year-ago
 * figure, each in a column of its own.
 */
export const EARNINGS_ESTIMATE_COLUMNS = [
  ...EVENT_COLUMNS.filter((column) => column.key !== "value" && column.key !== "detail"),
  {
    key: "surprisePercent", header: "EPS surp", align: "right" as const,
    format: (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value)),
  },
  {
    key: "estimateGrowth", header: "YoY growth", align: "right" as const,
    format: (value: unknown) => value == null ? "-" : formatPercent(Number(value)),
    // The text says which figure grew, as the pane does; exports keep the percent a number.
    textFormat: (value: unknown, row: Record<string, unknown>) => value == null ? "-"
      : `${formatPercent(Number(value))} ${row.estimateGrowthMetric === "revenue" ? "rev" : "EPS"}`,
  },
  { key: "detail", header: "Detail" },
];

export interface EventSources {
  actions: CorporateActionsData | null;
  estimates: AnalystResearchData | null;
  financials: TickerFinancials | null;
  currency: string;
  /** Why a source failed; null when it answered or the provider does not offer it. */
  actionsError: string | null;
  estimatesError: string | null;
  financialsError: string | null;
}

function settledError(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === "fulfilled") return null;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/**
 * Corporate actions, analyst research and financials together; one failing
 * leaves the others. The earnings rows are resolved against the earnings
 * calendar on the listing's own day (`listingDay`: SIE:XETRA's report has
 * passed once Berlin's day has), so the next report reads as `earnings` and
 * ERN give it.
 */
export async function loadEventSources(
  provider: DataProvider,
  symbol: string,
  today = listingDay(parsePublicTickerKey(symbol).exchange),
): Promise<EventSources> {
  const [actions, estimates, financials, calendar] = await Promise.allSettled([
    provider.getCorporateActions?.(symbol, "") ?? null,
    // A listing no analyst covers answers with no estimates, not a failure.
    provider.getAnalystResearch ? loadAnalystResearch(provider, symbol, "") : null,
    provider.getTickerFinancials(symbol, ""),
    loadEarningsCalendar(provider, [symbol]),
  ]);
  const event = calendar.status === "fulfilled" ? calendarEventOf(calendar.value.events, symbol) : null;
  const actionsData = actions.status === "fulfilled" && actions.value ? withResolvedEarnings(actions.value, event, today) : null;
  const estimatesData = estimates.status === "fulfilled" ? estimates.value : null;
  const financialsData = financials.status === "fulfilled" ? financials.value : null;
  return {
    actions: actionsData,
    estimates: estimatesData,
    financials: financialsData,
    currency: actionsData?.currency ?? estimatesData?.currency ?? financialsData?.quote?.currency ?? "",
    actionsError: settledError(actions),
    estimatesError: settledError(estimates),
    financialsError: settledError(financials),
  };
}
