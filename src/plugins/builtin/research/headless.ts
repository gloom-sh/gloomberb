import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import { buildEventRows, type EventRow } from "./event-model";

const ESTIMATE_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "status", header: "Event" },
  { key: "period", header: "Period" },
  { key: "qEps", header: "Q EPS", align: "right" as const },
  { key: "qRevenue", header: "Q revenue", align: "right" as const },
  { key: "annualEps", header: "Annual EPS", align: "right" as const },
  { key: "annualRevenue", header: "Annual revenue", align: "right" as const },
  { key: "value", header: "Value", align: "right" as const },
  { key: "detail", header: "Detail" },
];

export interface EarningsEstimateSources {
  actions: CorporateActionsData | null;
  estimates: AnalystResearchData | null;
  financials: TickerFinancials | null;
  currency: string;
  errors?: string[];
}

export interface EarningsEstimatesHeadlessDependencies {
  loadSources(
    symbol: string,
    context: HeadlessPaneContext,
  ): Promise<EarningsEstimateSources>;
}

async function settledValue<T>(
  promise: Promise<T> | null,
  errors: string[],
  label: string,
): Promise<T | null> {
  if (!promise) return null;
  try {
    return await promise;
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const defaultDependencies: EarningsEstimatesHeadlessDependencies = {
  async loadSources(symbol, context) {
    const errors: string[] = [];
    const provider = context.marketData;
    const [actions, estimates, financials] = await Promise.all([
      settledValue(
        provider.getCorporateActions?.(symbol, "") ?? null,
        errors,
        "corporate actions",
      ),
      settledValue(
        provider.getAnalystResearch?.(symbol, "") ?? null,
        errors,
        "analyst estimates",
      ),
      settledValue(provider.getTickerFinancials(symbol, ""), errors, "financials"),
    ]);
    if (!actions && !estimates && !financials && errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    return {
      actions,
      estimates,
      financials,
      currency: actions?.currency ?? estimates?.currency ?? financials?.quote?.currency ?? "USD",
      errors,
    };
  },
};

function matchesKind(row: EventRow, kind: string): boolean {
  if (kind === "all") return true;
  if (kind === "estimates") return row.status === "Q Est" || row.status === "FY Est";
  return row.status === "Earnings" || row.status === "TTM";
}

export function projectEarningsEstimatesHeadless(
  sources: EarningsEstimateSources,
  args: HeadlessPaneLoadArgs,
): HeadlessRowsResult {
  const kind = String(args.options.kind ?? "all");
  const limit = Number(args.options.limit ?? 50);
  const matching = buildEventRows(
    sources.actions,
    sources.estimates,
    sources.financials,
    sources.currency,
  ).filter((row) => matchesKind(row, kind));
  const rows = matching.slice(0, limit).map((row) => ({ ...row }));

  return {
    columns: ESTIMATE_COLUMNS,
    rows,
    errors: sources.errors?.length ? sources.errors : undefined,
    metadata: {
      currency: sources.currency,
      kind,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
    },
  };
}

export function createEarningsEstimatesHeadless(
  dependencies: EarningsEstimatesHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Company symbol.",
    },
    options: [
      {
        key: "kind",
        description: "Estimate or reported rows to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "estimates" },
          { value: "reported" },
        ],
        defaultValue: "all",
      },
      {
        key: "limit",
        description: "Maximum rows to return.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: ESTIMATE_COLUMNS,
    describe: (args) => `Earnings Estimates | ${String(args.argument)}`,
    async load(args, context) {
      return projectEarningsEstimatesHeadless(
        await dependencies.loadSources(String(args.argument), context),
        args,
      );
    },
  };
}

export const earningsEstimatesHeadless = createEarningsEstimatesHeadless();
