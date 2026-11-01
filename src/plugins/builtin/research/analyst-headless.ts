import type {
  HeadlessBundleSection,
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { AnalystResearchData, Quote } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";
import { formatPercent } from "../../../utils/format";
import { loadAnalystResearch } from "./client";
import {
  analystReferenceMetadata,
  analystTargetCurrency,
  analystUpside,
  formatAnalystReference,
  formatAnalystPrice,
  formatRecommendationMix,
  recommendationMix,
  formatRatingLabel,
  formatRatingTarget,
  ratingReason,
  recommendationTotal,
  sortRatingRows,
  type RatingColumnId,
} from "./analyst-model";
import { REPORTED_DATA } from "../shared/report-freshness";
import { REPORT_ROWS, REPORT_SORT } from "../shared/headless-options";

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

type RatingRow = AnalystResearchData["ratings"][number];

/**
 * The reason coverage gave, on its own line under the action with its
 * article; exports keep the line and the article's address as columns. Only
 * a history with a reason somewhere has them.
 */
const REASON_COLUMNS: HeadlessPaneColumn[] = [
  {
    key: "reason",
    header: "Reason",
    underRow: true,
    format: (_value, row) => ratingReason(row as unknown as RatingRow)?.text ?? "",
    textFormat: (_value, row) => {
      const reason = ratingReason(row as unknown as RatingRow);
      return reason ? `${reason.text} · ${reason.url}` : "";
    },
  },
  { key: "reasonUrl", header: "Reason URL", underRow: true, textFormat: () => "" },
];

const SORT_COLUMNS: Record<string, RatingColumnId> = {
  date: "date",
  firm: "firm",
  action: "action",
  rating: "current",
  target: "target",
};

/** The summary: the upside from Last (the quote's regular session price), and the price and time it is measured from, as `analyst` gives them. */
function overviewEntries(data: AnalystResearchData, quote: Quote | null): HeadlessPaneEntry[] {
  const target = data.priceTarget;
  const currency = analystTargetCurrency(data);
  const { upside, reference } = analystUpside(data, quote);
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
      value: reference.price ?? null,
      formatted: formatAnalystReference(reference, currency),
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
  /** The listing's quote, whose regular session price the upside is measured from; null when none loads. */
  loadQuote?(symbol: string, ctx: HeadlessPaneContext): Promise<Quote | null>;
}

const defaultDependencies: AnalystResearchHeadlessDependencies = {
  async loadData(symbol, _args, ctx) {
    const instrument = await ctx.resolveInstrument?.(symbol);
    return loadAnalystResearch(ctx.marketData, symbol, instrument?.exchange);
  },
  async loadQuote(symbol, ctx) {
    const instrument = await ctx.resolveInstrument?.(symbol);
    return ctx.marketData.getQuote(instrument?.symbol ?? symbol, instrument?.exchange ?? "")
      .catch(logFailure("analyst", "Read the quote the upside is measured from failed", null));
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
        shot: REPORT_SORT,
        description: "Column used to sort analyst actions.",
        type: "enum",
        values: Object.keys(SORT_COLUMNS).map((value) => ({ value })),
        defaultValue: "date",
      },
      {
        key: "order",
        shot: REPORT_SORT,
        description: "Sort direction.",
        type: "enum",
        values: [{ value: "desc" }, { value: "asc" }],
        defaultValue: "desc",
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
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
      const [data, quote] = await Promise.all([
        dependencies.loadData(symbol, args, ctx),
        dependencies.loadQuote?.(symbol, ctx) ?? Promise.resolve(null),
      ]);
      const { upside, reference } = analystUpside(data, quote);
      const currency = analystTargetCurrency(data);
      const ratings = sortRatingRows(data.ratings, {
        columnId: SORT_COLUMNS[String(args.options.sort)] ?? "date",
        direction: args.options.order === "asc" ? "asc" : "desc",
      })
        .slice(0, Number(args.options.limit))
        .map((rating) => {
          const reason = ratingReason(rating);
          return {
            ...rating,
            target: rating.currentPriceTarget ?? rating.priorPriceTarget ?? null,
            currency: currency ?? null,
            ...(reason ? { reasonUrl: reason.url } : {}),
          };
        });
      const columns = ratings.some((rating) => ratingReason(rating)) ? [...RATING_COLUMNS, ...REASON_COLUMNS] : RATING_COLUMNS;
      const sections: HeadlessBundleSection[] = [
        { title: "Summary", entries: overviewEntries(data, quote) },
        { title: "Recent analyst actions", columns, rows: ratings },
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
          upside: upside ?? null,
          upsideReference: analystReferenceMetadata(reference),
        },
      };
    },
  };
}

export const analystResearchHeadless = createAnalystResearchHeadless();
