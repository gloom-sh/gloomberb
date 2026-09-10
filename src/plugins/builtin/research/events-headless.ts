import type { DataProvider } from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatEventMetric, buildEventRows, eventSourceNotice } from "./event-model";

const COLUMNS = [
  { key: "date", header: "Date" },
  { key: "status", header: "Event" },
  { key: "period", header: "Period" },
  { key: "qEps", header: "Q EPS", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatEventMetric(value == null ? undefined : Number(value), typeof row.epsCurrency === "string" ? row.epsCurrency : undefined, "eps") },
  { key: "qRevenue", header: "Q revenue", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatEventMetric(value == null ? undefined : Number(value), typeof row.revenueCurrency === "string" ? row.revenueCurrency : undefined, "revenue") },
  { key: "annualEps", header: "Annual EPS", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatEventMetric(value == null ? undefined : Number(value), typeof row.epsCurrency === "string" ? row.epsCurrency : undefined, "eps") },
  { key: "annualRevenue", header: "Annual revenue", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatEventMetric(value == null ? undefined : Number(value), typeof row.revenueCurrency === "string" ? row.revenueCurrency : undefined, "revenue") },
  { key: "value", header: "Value", align: "right" as const },
  { key: "detail", header: "Detail" },
];

export interface EventHeadlessData {
  actions: CorporateActionsData | null;
  estimates: AnalystResearchData | null;
  financials: TickerFinancials | null;
  currency: string;
  actionsError?: string | null;
  estimatesError?: string | null;
  financialsError?: string | null;
}

export interface EventsHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    symbol: string,
    provider: DataProvider,
  ): Promise<EventHeadlessData>;
}

const defaultDependencies: EventsHeadlessDependencies = {
  async load(_args, symbol, provider) {
    const [actions, estimates, financials] = await Promise.allSettled([
      provider.getCorporateActions ? provider.getCorporateActions(symbol, "") : Promise.reject(new Error("Corporate actions source unavailable")),
      provider.getAnalystResearch
        ? provider.getAnalystResearch(symbol, "")
        : Promise.reject(new Error("Analyst estimates source unavailable")),
      provider.getTickerFinancials(symbol, ""),
    ]);
    const actionsData = actions.status === "fulfilled" ? actions.value : null;
    const estimatesData = estimates.status === "fulfilled" ? estimates.value : null;
    const financialsData = financials.status === "fulfilled" ? financials.value : null;
    const error = (result: PromiseSettledResult<unknown>) => result.status === "rejected" ? String(result.reason instanceof Error ? result.reason.message : result.reason) : null;
    return {
      actions: actionsData,
      estimates: estimatesData,
      financials: financialsData,
      actionsError: error(actions),
      estimatesError: error(estimates),
      financialsError: error(financials),
      currency: actionsData?.currency ?? estimatesData?.currency ?? financialsData?.quote?.currency ?? "USD",
    };
  },
};

export function createEventsHeadless(
  dependencies: EventsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Ticker whose corporate actions and estimates should be returned.",
    },
    options: [],
    columns: COLUMNS,
    describe: (args) => `Corporate Actions | ${String(args.argument)}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const data = await dependencies.load(args, symbol, ctx.marketData);
      const notice = eventSourceNotice({ variant: "corporate-actions", symbol,
        actions: data.actions, actionsError: data.actionsError ?? null,
        estimates: data.estimates, estimatesError: data.estimatesError ?? null });
      const errors = [notice?.failed ? notice.text : null,
        data.financialsError ? `Financial statements unavailable: ${data.financialsError}` : null,
      ].filter((error): error is string => !!error);
      return {
        rows: buildEventRows(data.actions, data.estimates, data.financials, data.currency)
          .map((row) => ({ ...row })),
        errors: errors.length > 0 ? errors : undefined,
        metadata: { symbol, currency: data.currency, coverage: data.actions?.coverage,
          actionsFetchedAt: data.actions?.fetchedAt, estimatesFetchedAt: data.estimates?.fetchedAt,
          ...(notice ? { notice: notice.text } : {}),
        },
      };
    },
  };
}

export const eventsHeadless = createEventsHeadless();
