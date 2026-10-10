import type {
  HeadlessBundleSection,
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { AnalystResearchData } from "../../../types/financials";
import { formatPercent } from "../../../utils/format";
import { loadAnalystResearch } from "./client";
import {
  analystTargetCurrency,
  formatAnalystPrice,
  formatRecommendationMix,
  recommendationMix,
  formatRatingLabel,
  formatRatingTarget,
  recommendationTotal,
  sortRatingRows,
  targetUpside,
  type RatingColumnId,
} from "./analyst-model";
import { REPORTED_DATA } from "../shared/report-freshness";

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
      typeof row.currency === "string" ? row.currency : undefined,
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
  const currency = analystTargetCurrency(data);
  const upside = targetUpside(target);
  return [
    {
      label: "Average target",
      value: target?.average ?? null,
      formatted: formatAnalystPrice(target?.average, currency),
    },
    {
      label: "Target upside",
      value: upside ?? null,
      formatted: upside == null ? "-" : formatPercent(upside),
    },
    {
      label: "Upside reference price",
      value: target?.current ?? null,
      formatted: formatAnalystPrice(target?.current, currency),
    },
    {
      label: "Target range",
      value: target ? { low: target.low, median: target.median, high: target.high } : null,
      formatted: target
        ? [target.low, target.median, target.high]
          .map((value) => formatAnalystPrice(value, currency))
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
      value: recommendationMix(data),
      formatted: formatRecommendationMix(data),
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
  async loadData(symbol, _args, ctx) {
    const instrument = await ctx.resolveInstrument?.(symbol);
    return loadAnalystResearch(ctx.marketData, symbol, instrument?.exchange);
  },
};

export function createAnalystResearchHeadless(
  dependencies: AnalystResearchHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { ...REPORTED_DATA, basis: "analyst ratings" },
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
      const currency = analystTargetCurrency(data);
      const ratings = sortRatingRows(data.ratings, {
        columnId: SORT_COLUMNS[String(args.options.sort)] ?? "date",
        direction: args.options.order === "asc" ? "asc" : "desc",
      })
        .slice(0, Number(args.options.limit))
        .map((rating) => ({
          ...rating,
          target: rating.currentPriceTarget ?? rating.priorPriceTarget ?? null,
          currency: currency ?? null,
        }));
      const sections: HeadlessBundleSection[] = [
        { title: "Summary", entries: overviewEntries(data) },
        { title: "Recent analyst actions", columns: RATING_COLUMNS, rows: ratings },
      ];
      return {
        sections,
        errors: data.stale ? ["Analyst research is stale"] : undefined,
        ...(data.stale ? { freshness: { status: "stale" as const } } : {}),
        metadata: {
          symbol: data.symbol || symbol,
          name: data.name ?? null,
          currency: currency ?? null,
          fetchedAt: data.fetchedAt,
          stale: data.stale,
        },
      };
    },
  };
}

export const analystResearchHeadless = createAnalystResearchHeadless();
