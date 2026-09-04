import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../types/plugin";
import { PREDICTION_CATEGORY_OPTIONS } from "./categories";
import {
  filterPredictionMarkets,
  getDefaultPredictionSort,
  sortPredictionMarkets,
} from "./metrics";
import { parsePredictionSearchShortcut } from "./navigation";
import { buildPredictionListRows } from "./rows";
import { loadKalshiCatalog } from "./services/kalshi/adapter";
import { loadPolymarketCatalog } from "./services/polymarket/adapter";
import type {
  PredictionBrowseTab,
  PredictionCategoryId,
  PredictionListRow,
  PredictionMarketSummary,
  PredictionVenueScope,
} from "./types";

const PREDICTION_COLUMNS = [
  { key: "venue", header: "Venue" },
  { key: "title", header: "Market" },
  { key: "target", header: "Target" },
  { key: "yesProbability", header: "Yes", align: "right" as const },
  { key: "spread", header: "Spread", align: "right" as const },
  { key: "volume24h", header: "24h volume", align: "right" as const },
  { key: "openInterest", header: "Open interest", align: "right" as const },
  { key: "endsAt", header: "Ends" },
  { key: "status", header: "Status" },
  { key: "category", header: "Category" },
];

export interface PredictionMarketsHeadlessDependencies {
  loadPolymarket(
    query: string,
    category: PredictionCategoryId,
    limit: number,
  ): Promise<PredictionMarketSummary[]>;
  loadKalshi(
    query: string,
    category: PredictionCategoryId,
    limit: number,
  ): Promise<PredictionMarketSummary[]>;
  now(): Date;
}

const defaultDependencies: PredictionMarketsHeadlessDependencies = {
  loadPolymarket: (query, category, limit) => loadPolymarketCatalog(
    query,
    category,
    { limit },
  ),
  loadKalshi: (query, category, limit) => loadKalshiCatalog(
    query,
    category,
    { limit },
  ),
  now: () => new Date(),
};

interface PredictionSelection {
  query: string;
  venue: PredictionVenueScope;
  category: PredictionCategoryId;
  tab: PredictionBrowseTab;
  limit: number;
}

function selectionFor(args: HeadlessPaneLoadArgs): PredictionSelection {
  const parsed = parsePredictionSearchShortcut(
    typeof args.argument === "string" ? args.argument : "",
  );
  const optionVenue = String(args.options.venue ?? "all") as PredictionVenueScope;
  return {
    query: parsed.searchQuery,
    venue: optionVenue === "all" ? parsed.venueScope : optionVenue,
    category: String(args.options.category ?? "all") as PredictionCategoryId,
    tab: String(args.options.tab ?? "top") as PredictionBrowseTab,
    limit: Number(args.options.limit ?? 50),
  };
}

function rowForHeadless(row: PredictionListRow) {
  const focusMarket = row.markets.find((market) => market.key === row.focusMarketKey)
    ?? row.representative;
  return {
    key: row.key,
    kind: row.kind,
    venue: row.venue,
    title: row.title,
    target: row.focusMarketLabel,
    yesProbability: row.focusYesPrice,
    noProbability: focusMarket.noPrice,
    targetMarketId: focusMarket.marketId,
    marketId: row.marketId,
    event: row.eventLabel,
    category: row.category ?? null,
    tags: row.tags ?? [],
    status: row.status,
    url: row.url,
    description: row.description,
    endsAt: row.endsAt,
    updatedAt: row.updatedAt,
    spread: row.spread,
    lastTradePrice: row.lastTradePrice,
    volume24h: row.volume24h,
    volume24hUnit: row.volume24hUnit,
    totalVolume: row.totalVolume,
    totalVolumeUnit: row.totalVolumeUnit,
    openInterest: row.openInterest,
    openInterestUnit: row.openInterestUnit,
    liquidity: row.liquidity,
    liquidityUnit: row.liquidityUnit,
    marketCount: row.kind === "group" ? row.marketCount : 1,
    yesProbabilityLow: row.kind === "group" ? row.yesPriceLow : row.yesPrice,
    yesProbabilityHigh: row.kind === "group" ? row.yesPriceHigh : row.yesPrice,
  };
}

export function projectPredictionMarketsHeadless(
  markets: PredictionMarketSummary[],
  errors: string[],
  args: HeadlessPaneLoadArgs,
  now: Date,
): HeadlessRowsResult {
  const selection = selectionFor(args);
  const rows = sortPredictionMarkets(
    filterPredictionMarkets(
      buildPredictionListRows(markets),
      selection.tab,
      selection.venue,
      selection.category,
      selection.query,
      new Set(),
    ),
    getDefaultPredictionSort(selection.tab),
  );
  const selectedRows = rows.slice(0, selection.limit).map(rowForHeadless);

  return {
    columns: PREDICTION_COLUMNS,
    rows: selectedRows,
    errors: errors.length > 0 ? errors : undefined,
    metadata: {
      fetchedAt: now.toISOString(),
      query: selection.query || null,
      venue: selection.venue,
      category: selection.category,
      tab: selection.tab,
      sourceMarkets: markets.length,
      total: rows.length,
      returned: selectedRows.length,
      truncated: selectedRows.length < rows.length,
    },
  };
}

export function createPredictionMarketsHeadless(
  dependencies: PredictionMarketsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "free-text",
      placeholder: "query",
      description: "Optional market query, including polymarket: or kalshi: shorthand.",
      optional: true,
    },
    options: [
      {
        key: "venue",
        description: "Prediction venue to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "polymarket" },
          { value: "kalshi" },
        ],
        defaultValue: "all",
      },
      {
        key: "category",
        description: "Market category to include.",
        type: "enum",
        values: PREDICTION_CATEGORY_OPTIONS.map((option) => ({ value: option.id })),
        defaultValue: "all",
      },
      {
        key: "tab",
        description: "Browse ordering to apply.",
        type: "enum",
        values: [
          { value: "top" },
          { value: "ending" },
          { value: "new" },
        ],
        defaultValue: "top",
      },
      {
        key: "limit",
        description: "Maximum market rows to return.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: PREDICTION_COLUMNS,
    describe: (args) => {
      const selection = selectionFor(args);
      return selection.query
        ? `Prediction Markets | ${selection.query}`
        : "Prediction Markets";
    },
    async load(args) {
      const selection = selectionFor(args);
      const requested: Array<{
        venue: "polymarket" | "kalshi";
        load: Promise<PredictionMarketSummary[]>;
      }> = [];
      if (selection.venue !== "kalshi") {
        requested.push({
          venue: "polymarket",
          load: dependencies.loadPolymarket(selection.query, selection.category, 200),
        });
      }
      if (selection.venue !== "polymarket") {
        requested.push({
          venue: "kalshi",
          load: dependencies.loadKalshi(selection.query, selection.category, 200),
        });
      }
      const settled = await Promise.allSettled(requested.map((request) => request.load));
      const markets: PredictionMarketSummary[] = [];
      const errors: string[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") {
          markets.push(...result.value);
        } else {
          const message = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
          errors.push(`${requested[index]?.venue ?? "venue"}: ${message}`);
        }
      }
      return projectPredictionMarketsHeadless(markets, errors, args, dependencies.now());
    },
  };
}

export const predictionMarketsHeadless = createPredictionMarketsHeadless();
