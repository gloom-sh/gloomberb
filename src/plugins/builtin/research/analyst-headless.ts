import type {
  HeadlessBundleSection,
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { AnalystResearchData } from "../../../types/financials";
import { formatCurrency, formatPercent } from "../../../utils/format";
import { loadAnalystResearch } from "./client";
import {
  formatRatingLabel,
  formatRatingTarget,
  latestRecommendation,
  recommendationTotal,
  sortRatingRows,
  targetUpside,
  type RatingColumnId,
} from "./analyst-model";

const RATING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "firm", header: "Firm" },
  { key: "action", header: "Action" },
  { key: "current", header: "Rating" },
  {
    key: "target",
    header: "Target",
    format: (_value, row) => formatRatingTarget(
      row as unknown as AnalystResearchData["ratings"][number],
      String(row.currency ?? "USD"),
    ).trim(),
  },
  { key: "prior", header: "Prior" },
];

const SORT_COLUMNS: Record<string, RatingColumnId> = {
  date: "date",
  firm: "firm",
  action: "action",
  rating: "current",
  target: "target",
};

function overviewEntries(data: AnalystResearchData): HeadlessPaneEntry[] {
  const target = data.priceTarget;
  const currency = target?.currency ?? data.currency ?? "USD";
  const recommendation = latestRecommendation(data);
  const upside = targetUpside(target);
  return [
    {
      label: "Average target",
      value: target?.average ?? null,
      formatted: target?.average == null ? "-" : formatCurrency(target.average, currency),
    },
    {
      label: "Target upside",
      value: upside ?? null,
      formatted: upside == null ? "-" : formatPercent(upside),
    },
    {
      label: "Target range",
      value: target ? { low: target.low, median: target.median, high: target.high } : null,
      formatted: target
        ? [target.low, target.median, target.high]
          .map((value) => value == null ? "-" : formatCurrency(value, currency))
          .join(" / ")
        : "-",
    },
    {
      label: "Recommendation rating",
      value: data.recommendationRating ?? null,
      formatted: formatRatingLabel(data.recommendationRating),
    },
    { label: "Analysts", value: recommendationTotal(data) },
    {
      label: "Recommendation mix",
      value: recommendation ? {
        period: recommendation.period,
        strongBuy: recommendation.strongBuy ?? 0,
        buy: recommendation.buy ?? 0,
        hold: recommendation.hold ?? 0,
        sell: recommendation.sell ?? 0,
        strongSell: recommendation.strongSell ?? 0,
      } : null,
      formatted: recommendation
        ? `SB ${recommendation.strongBuy ?? 0}  B ${recommendation.buy ?? 0}  H ${recommendation.hold ?? 0}  S ${(recommendation.sell ?? 0) + (recommendation.strongSell ?? 0)}`
        : "-",
    },
  ];
}

export interface AnalystResearchHeadlessDependencies {
  loadData(
    symbol: string,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<AnalystResearchData>;
}

const defaultDependencies: AnalystResearchHeadlessDependencies = {
  loadData: (symbol, _args, ctx) => loadAnalystResearch(ctx.marketData, symbol),
};

export function createAnalystResearchHeadless(
  dependencies: AnalystResearchHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Ticker whose analyst research should be loaded.",
    },
    options: [
      {
        key: "sort",
        description: "Column used to sort analyst actions.",
        type: "enum",
        values: Object.keys(SORT_COLUMNS).map((value) => ({ value })),
        defaultValue: "date",
      },
      {
        key: "order",
        description: "Sort direction.",
        type: "enum",
        values: [{ value: "desc" }, { value: "asc" }],
        defaultValue: "desc",
      },
      {
        key: "limit",
        aliases: ["count", "rows"],
        description: "Maximum analyst action rows.",
        type: "integer",
        defaultValue: 25,
        minimum: 1,
        maximum: 100,
      },
    ],
    describe: (args) => `Analyst Research | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const data = await dependencies.loadData(symbol, args, ctx);
      const currency = data.priceTarget?.currency ?? data.currency ?? "USD";
      const ratings = sortRatingRows(data.ratings, {
        columnId: SORT_COLUMNS[String(args.options.sort)] ?? "date",
        direction: args.options.order === "asc" ? "asc" : "desc",
      })
        .slice(0, Number(args.options.limit))
        .map((rating) => ({
          ...rating,
          target: rating.currentPriceTarget ?? rating.priorPriceTarget ?? null,
          currency,
        }));
      const sections: HeadlessBundleSection[] = [
        { title: "Summary", entries: overviewEntries(data) },
        { title: "Recent analyst actions", columns: RATING_COLUMNS, rows: ratings },
      ];
      return {
        sections,
        metadata: {
          symbol: data.symbol || symbol,
          name: data.name ?? null,
          currency,
        },
      };
    },
  };
}

export const analystResearchHeadless = createAnalystResearchHeadless();
