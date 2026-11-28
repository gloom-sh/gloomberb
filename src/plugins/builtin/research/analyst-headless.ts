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
import { hasAnalystCoverage, loadAnalystResearch, noAnalystCoverageText, noAnalystActionsText } from "./client";
import {
  analystReferenceMetadata,
  analystTargetCurrency,
  analystUpside,
  buildAnalystOverview,
  formatRatingReason,
  formatRatingTarget,
  ratingReason,
  sortRatingRows,
  type RatingColumnId,
} from "./analyst-model";
import { REPORTED_DATA } from "../shared/report-freshness";
import { enumOption, limitOption, REPORT_SORT } from "../shared/headless-options";

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
    textFormat: (_value, row) => formatRatingReason(ratingReason(row as unknown as RatingRow)) ?? "",
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
  const s = buildAnalystOverview(data, quote);
  return [
    { label: "Average target", value: s.target?.average ?? null, formatted: s.averageFormatted },
    { label: "Target upside", value: s.upside ?? null, formatted: s.upsideFormatted },
    { label: "Upside reference price", value: s.reference.price ?? null, formatted: s.referenceFormatted },
    { label: "Target range", value: s.target ? { low: s.target.low, median: s.target.median, high: s.target.high } : null, formatted: s.rangeFormatted },
    { label: "Recommendation rating", value: data.recommendationRating ?? null, formatted: s.ratingFormatted },
    { label: "Analysts", value: s.analysts },
    { label: "Recommendation mix", value: s.mix, formatted: s.mixFormatted },
  ];
}

interface AnalystResearchHeadlessDependencies {
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

function createAnalystResearchHeadless(
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
      enumOption("sort", Object.keys(SORT_COLUMNS), { shot: REPORT_SORT, description: "Column used to sort analyst actions.", defaultValue: "date" }),
      enumOption("order", ["desc", "asc"], { shot: REPORT_SORT, description: "Sort direction.", defaultValue: "desc" }),
      limitOption({ aliases: ["count", "rows"], description: "Maximum analyst action rows.", defaultValue: 25, maximum: 100 }),
    ],
    describe: (args) => `Analyst Research | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const [data, quote] = await Promise.all([
        dependencies.loadData(symbol, args, ctx),
        dependencies.loadQuote?.(symbol, ctx) ?? Promise.resolve(null),
      ]);
      // A listing no analyst covers has nothing to sum up or list: the report says so once.
      if (!hasAnalystCoverage(data)) {
        return {
          sections: [{ title: "Recent analyst actions", columns: RATING_COLUMNS, rows: [] }],
          empty: noAnalystCoverageText(data.symbol || symbol),
          metadata: { symbol: data.symbol || symbol, name: data.name ?? null },
        };
      }
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
        { title: "Recent analyst actions", columns, rows: ratings, empty: noAnalystActionsText(symbol) },
      ];
      return {
        sections,
        errors: data.stale ? ["Analyst research is stale"] : undefined,
        // When Gloom Cloud read the targets and the mix, which carry no date of their own.
        ...(data.stale || data.fetchedAt ? { freshness: {
          ...(data.stale ? { status: "stale" as const } : {}),
          ...(data.fetchedAt ? { retrievedAt: data.fetchedAt } : {}),
        } } : {}),
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
