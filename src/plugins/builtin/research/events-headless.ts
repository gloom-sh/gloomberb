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
import { formatCompact, formatNumber } from "../../../utils/format";
import { buildEventRows } from "./event-model";

const COLUMNS = [
  { key: "date", header: "Date" },
  { key: "status", header: "Event" },
  { key: "period", header: "Period" },
  { key: "qEps", header: "Q EPS", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatNumber(Number(value), 2) },
  { key: "qRevenue", header: "Q revenue", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatCompact(Number(value)) },
  { key: "annualEps", header: "Annual EPS", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatNumber(Number(value), 2) },
  { key: "annualRevenue", header: "Annual revenue", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatCompact(Number(value)) },
  { key: "value", header: "Value", align: "right" as const },
  { key: "detail", header: "Detail" },
];

export interface EventHeadlessData {
  actions: CorporateActionsData | null;
  estimates: AnalystResearchData | null;
  financials: TickerFinancials | null;
  currency: string;
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
    if (!provider.getCorporateActions) {
      throw new Error("Corporate actions source unavailable");
    }
    const [actions, estimates, financials] = await Promise.all([
      provider.getCorporateActions(symbol, ""),
      provider.getAnalystResearch
        ? provider.getAnalystResearch(symbol, "").catch(() => null)
        : null,
      provider.getTickerFinancials(symbol, "").catch(() => null),
    ]);
    return {
      actions,
      estimates,
      financials,
      currency: actions.currency ?? estimates?.currency ?? financials?.quote?.currency ?? "USD",
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
      return {
        rows: buildEventRows(data.actions, data.estimates, data.financials, data.currency)
          .map((row) => ({ ...row })),
        metadata: { symbol, currency: data.currency },
      };
    },
  };
}

export const eventsHeadless = createEventsHeadless();
