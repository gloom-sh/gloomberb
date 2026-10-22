import type { DataProvider } from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import { formatEventMetric } from "./event-model";
import { loadEarningsCalendar } from "../earnings/data/cache";
import { calendarEventOf, newYorkDay, withResolvedEarnings } from "../shared/earnings-calendar";

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
 * calendar, so the next report reads as `earnings` and ERN give it.
 */
export async function loadEventSources(provider: DataProvider, symbol: string, today = newYorkDay()): Promise<EventSources> {
  const [actions, estimates, financials, calendar] = await Promise.allSettled([
    provider.getCorporateActions?.(symbol, "") ?? null,
    provider.getAnalystResearch?.(symbol, "") ?? null,
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
