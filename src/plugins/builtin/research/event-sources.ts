import type { DataProvider } from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import { formatEventMetric, isFundListing, type EventSummaryFigure } from "./event-model";
import { fundCorporateActions } from "../../../market-data/fund-actions";
import type { HeadlessBundleSection, HeadlessPaneColumn } from "../../../types/headless";
import { quartersEpsBasis, type EarningsQuarter } from "./event-charts";
import { loadAnalystResearch } from "./client";
import { MISSING_VALUE, formatPercent, formatPercentRaw } from "../../../utils/format";
import { NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
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

/** The figures over the events views (buildNextUp, buildEarningsHeader), as the text reports print them under their rows. */
export function eventSummarySection(figures: readonly EventSummaryFigure[]): HeadlessBundleSection {
  return {
    title: "Next up",
    entries: figures.map((figure) => ({
      key: figure.id, label: figure.label, value: figure.value,
      formatted: figure.detail ? `${figure.value}  ${figure.detail}` : figure.value,
    })),
  };
}

/**
 * The Earnings view's table (EVT's, and EE's Reported), as the text reports
 * print it: one row per quarter, the next one first, the EPS heading naming
 * the basis most reported quarters share (`Adj EPS`), as the pane's does.
 */
export function quarterTextColumns(quarters: readonly EarningsQuarter[]): HeadlessPaneColumn[] {
  const basis = quartersEpsBasis(quarters);
  return QUARTER_TEXT_COLUMNS.map((column) => column.key === "eps" && basis ? { ...column, header: basis === "GAAP" ? "GAAP EPS" : "Adj EPS" } : column);
}
const QUARTER_TEXT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "period", header: "Quarter" },
  { key: "eps", header: "EPS", align: "right" },
  { key: "estimate", header: "Est", align: "right" },
  { key: "surprise", header: "Surprise", align: "right" },
  { key: "revenue", header: "Revenue", align: "right" },
  { key: "detail", header: "Detail" },
];

export function quarterTextRows(quarters: readonly EarningsQuarter[]): Record<string, string>[] {
  return quarters.map((quarter) => ({
    date: quarter.date, period: quarter.period,
    eps: quarter.upcoming ? "" : formatEventMetric(quarter.eps, quarter.epsCurrency, "eps"),
    estimate: formatEventMetric(quarter.estimate, quarter.epsCurrency, "eps"),
    surprise: quarter.upcoming ? "" : quarter.surpriseNotMeaningful ? NOT_MEANINGFUL_TEXT
      : quarter.surprisePercent != null ? formatPercentRaw(quarter.surprisePercent) : MISSING_VALUE,
    revenue: quarter.upcoming ? "" : formatEventMetric(quarter.revenue, quarter.revenueCurrency, "revenue"),
    detail: quarter.detail,
  }));
}

/**
 * The columns of the earnings estimates report, as its pane heads them: what corporate actions
 * call Value is a reported quarter's EPS surprise or an estimate's growth over the year-ago
 * figure, each in a column of its own.
 */
export const EARNINGS_ESTIMATE_COLUMNS = [
  ...EVENT_COLUMNS.filter((column) => column.key !== "value" && column.key !== "detail"),
  {
    // Against a loss or zero estimate the surprise is N/M, as EVTS and ERN print it: JSON has null and
    // `surpriseNotMeaningful`, CSV an empty cell with `n/m` in its status column.
    key: "surprisePercent", header: "EPS surp", align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => typeof value !== "number" && row.surpriseNotMeaningful === true
      ? NOT_MEANINGFUL_TEXT.toLowerCase() : value == null ? MISSING_VALUE : formatPercentRaw(Number(value)),
    textFormat: (value: unknown, row: Record<string, unknown>) => typeof value !== "number" && row.surpriseNotMeaningful === true
      ? NOT_MEANINGFUL_TEXT : value == null ? MISSING_VALUE : formatPercentRaw(Number(value)),
  },
  {
    // Off a year-ago figure at or below zero the growth is N/M (`estimateGrowthNotMeaningful`), as the pane says.
    key: "estimateGrowth", header: "YoY growth", align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => typeof value !== "number" && row.estimateGrowthNotMeaningful === true
      ? NOT_MEANINGFUL_TEXT.toLowerCase() : value == null ? MISSING_VALUE : formatPercent(Number(value)),
    // The text says which figure grew, as the pane does; exports keep the percent a number.
    textFormat: (value: unknown, row: Record<string, unknown>) => {
      const metric = row.estimateGrowthMetric === "revenue" ? "rev" : "EPS";
      if (typeof value !== "number" && row.estimateGrowthNotMeaningful === true) return `${NOT_MEANINGFUL_TEXT} ${metric}`;
      return value == null ? MISSING_VALUE : `${formatPercent(Number(value))} ${metric}`;
    },
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
  const listingRead = Promise.allSettled([
    provider.getCorporateActions?.(symbol, "") ?? null,
    provider.getTickerFinancials(symbol, ""),
  ]).then(([actions, financials]) => {
    const recordedActions = actions.status === "fulfilled" ? actions.value : null;
    const financialsData = financials.status === "fulfilled" ? financials.value : null;
    return { actions, financials, recordedActions, financialsData, fund: isFundListing(financialsData, recordedActions) };
  });
  const [calendar, estimates] = await Promise.allSettled([
    loadEarningsCalendar(provider, [symbol]),
    listingRead.then(({ fund }) => !fund && provider.getAnalystResearch ? loadAnalystResearch(provider, symbol, "") : null),
  ]);
  const { actions, financials, recordedActions, financialsData, fund } = await listingRead;
  const event = calendar.status === "fulfilled" ? calendarEventOf(calendar.value.events, symbol) : null;
  const actionsData = recordedActions ? (fund ? fundCorporateActions(recordedActions) : withResolvedEarnings(recordedActions, event, today)) : null;
  const estimatesData = !fund && estimates.status === "fulfilled" ? estimates.value : null;
  return {
    actions: actionsData,
    estimates: estimatesData,
    financials: financialsData,
    currency: actionsData?.currency ?? estimatesData?.currency ?? financialsData?.quote?.currency ?? "",
    actionsError: settledError(actions),
    estimatesError: fund ? null : settledError(estimates),
    financialsError: settledError(financials),
  };
}
