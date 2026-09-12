import type { EarningsEvent } from "../../../types/data-provider";
import { coherentEarningsValue, earningsEpsChange30d, earningsForecastPeriod, earningsSourceEstimates } from "./estimate-basis";
import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import {
  loadEarningsCalendar,
  type EarningsCalendarResult,
} from "./data/cache";

const EARNINGS_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "timing", header: "When" },
  { key: "dateStatus", header: "Status" },
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "forecastPeriodEnd", header: "Forecast end" },
  { key: "epsCurrency", header: "EPS ccy" },
  { key: "epsEstimate", header: "EPS est", align: "right" as const },
  { key: "epsLow", header: "EPS low", align: "right" as const },
  { key: "epsHigh", header: "EPS high", align: "right" as const },
  { key: "epsGrowth", header: "EPS growth", align: "right" as const },
  { key: "epsTrend30dAgo", header: "EPS 30D ago", align: "right" as const },
  { key: "epsRevisionUp30d", header: "Rev up", align: "right" as const },
  { key: "epsRevisionDown30d", header: "Rev down", align: "right" as const },
  { key: "revenueCurrency", header: "Sales ccy" },
  { key: "revenueEstimate", header: "Sales est", align: "right" as const },
  { key: "revenueLow", header: "Sales low", align: "right" as const },
  { key: "revenueHigh", header: "Sales high", align: "right" as const },
  { key: "revenueGrowth", header: "Sales growth", align: "right" as const },
  { key: "epsAnalysts", header: "EPS analysts", align: "right" as const },
  { key: "revenueAnalysts", header: "Sales analysts", align: "right" as const },
];

export interface EarningsCalendarHeadlessDependencies {
  loadCalendar(
    symbols: string[],
    context: HeadlessPaneContext,
  ): Promise<EarningsCalendarResult>;
}

const defaultDependencies: EarningsCalendarHeadlessDependencies = {
  loadCalendar: (symbols, context) => loadEarningsCalendar(context.marketData, symbols),
};

function timingMatches(event: EarningsEvent, timing: string): boolean {
  if (timing === "all") return true;
  if (timing === "unknown") return !event.timing;
  return event.timing?.toUpperCase() === timing;
}

function eventRow(event: EarningsEvent) {
  return {
    date: event.earningsDate.toISOString(),
    earningsCallDate: event.earningsCallDate?.toISOString() ?? null,
    timing: event.timing || null,
    dateStatus: event.isDateEstimate == null
      ? null
      : event.isDateEstimate
        ? "estimated"
        : "confirmed",
    symbol: event.symbol,
    name: event.name,
    epsCurrency: event.estimateBasis?.epsEstimate?.currency ?? null,
    revenueCurrency: event.estimateBasis?.revenueEstimate?.currency ?? null,
    forecastPeriod: earningsForecastPeriod(event)?.period ?? null,
    forecastPeriodEnd: earningsForecastPeriod(event)?.periodEndDate ?? null,
    estimateBasis: event.estimateBasis ?? {},
    sourceEstimates: earningsSourceEstimates(event),
    epsChange30d: earningsEpsChange30d(event),
    epsEstimate: coherentEarningsValue(event, "epsEstimate"),
    epsLow: coherentEarningsValue(event, "epsLow"),
    epsHigh: coherentEarningsValue(event, "epsHigh"),
    epsYearAgo: coherentEarningsValue(event, "epsYearAgo"),
    epsGrowth: coherentEarningsValue(event, "epsGrowth"),
    epsAnalysts: coherentEarningsValue(event, "epsAnalysts"),
    epsTrend7dAgo: coherentEarningsValue(event, "epsTrend7dAgo"),
    epsTrend30dAgo: coherentEarningsValue(event, "epsTrend30dAgo"),
    epsRevisionUp7d: coherentEarningsValue(event, "epsRevisionUp7d"),
    epsRevisionUp30d: coherentEarningsValue(event, "epsRevisionUp30d"),
    epsRevisionDown7d: coherentEarningsValue(event, "epsRevisionDown7d"),
    epsRevisionDown30d: coherentEarningsValue(event, "epsRevisionDown30d"),
    epsActual: event.epsActual ?? null,
    revenueEstimate: coherentEarningsValue(event, "revenueEstimate"),
    revenueLow: coherentEarningsValue(event, "revenueLow"),
    revenueHigh: coherentEarningsValue(event, "revenueHigh"),
    revenueYearAgo: coherentEarningsValue(event, "revenueYearAgo"),
    revenueGrowth: coherentEarningsValue(event, "revenueGrowth"),
    revenueAnalysts: coherentEarningsValue(event, "revenueAnalysts"),
    revenueActual: event.revenueActual ?? null,
    surprise: event.surprise ?? null,
  };
}

export function projectEarningsCalendarHeadless(
  result: EarningsCalendarResult,
  args: HeadlessPaneLoadArgs,
): HeadlessRowsResult {
  const timing = String(args.options.timing ?? "all").toUpperCase();
  const normalizedTiming = timing === "ALL" || timing === "UNKNOWN"
    ? timing.toLowerCase()
    : timing;
  const limit = Number(args.options.limit ?? 50);
  const matching = result.events
    .filter((event) => timingMatches(event, normalizedTiming))
    .sort((left, right) => left.earningsDate.getTime() - right.earningsDate.getTime());
  const rows = matching.slice(0, limit).map(eventRow);

  return {
    columns: EARNINGS_COLUMNS,
    rows,
    errors: result.refreshError ? [result.refreshError] : undefined,
    metadata: {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      timing: normalizedTiming,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
    },
  };
}

export function createEarningsCalendarHeadless(
  dependencies: EarningsCalendarHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "symbol-list",
      placeholder: "tickers",
      description: "Comma-separated company symbols.",
      minimum: 1,
      maximum: 100,
    },
    options: [
      {
        key: "timing",
        description: "Release timing to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "BMO" },
          { value: "AMC" },
          { value: "TNS" },
          { value: "unknown" },
        ],
        defaultValue: "all",
      },
      {
        key: "limit",
        description: "Maximum earnings rows to return.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: EARNINGS_COLUMNS,
    describe: (args) => `Earnings Calendar | ${args.symbols.join(", ")}`,
    async load(args, context) {
      return projectEarningsCalendarHeadless(
        await dependencies.loadCalendar(args.symbols, context),
        args,
      );
    },
  };
}

export const earningsCalendarHeadless = createEarningsCalendarHeadless();
