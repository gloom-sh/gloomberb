import type { CloudNewsListResponse } from "../../../api-client";
import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessSnapshotResult,
} from "../../../types/plugin";
import type { NewsArticle, NewsQuery } from "../../../news/types";
import {
  cloudNewsParams,
  mapCloudNewsArticle,
} from "../../../sources/gloomberb-cloud/news";
import { parsePublicTickerKey } from "../../../utils/exchanges";

const NEWS_COLUMNS = [
  { key: "publishedAt", header: "Published" },
  { key: "source", header: "Source" },
  { key: "headline", header: "Headline" },
  { key: "tickers", header: "Tickers" },
  { key: "sentiment", header: "Sentiment" },
  { key: "importance", header: "Score", align: "right" as const },
];

export interface NewsHeadlessDependencies {
  loadNews(
    query: NewsQuery,
    context: HeadlessPaneContext,
  ): Promise<CloudNewsListResponse>;
  now(): Date;
}

const defaultDependencies: NewsHeadlessDependencies = {
  loadNews: (query, context) => context.apiClient.getCloudNews(cloudNewsParams(query)),
  now: () => new Date(),
};

function newsRow(article: NewsArticle) {
  return {
    id: article.id,
    publishedAt: article.publishedAt.toISOString(),
    source: article.source,
    headline: article.title,
    summary: article.summary ?? null,
    topic: article.topic,
    topics: article.topics,
    sectors: article.sectors,
    categories: article.categories,
    tickers: article.tickers,
    sentiment: article.sentiment ?? null,
    importance: article.scores.importance,
    urgency: article.scores.urgency,
    marketImpact: article.scores.marketImpact,
    novelty: article.scores.novelty,
    confidence: article.scores.confidence,
    breaking: article.isBreaking,
    developing: article.isDeveloping,
    sourceCount: article.sourceCount ?? article.items?.length ?? 0,
    url: article.url,
  };
}

function selectedSentiment(args: HeadlessPaneLoadArgs): string {
  return String(args.options.sentiment ?? "any");
}

export function projectNewsHeadless(
  response: CloudNewsListResponse,
  args: HeadlessPaneLoadArgs,
  now: Date,
): HeadlessSnapshotResult {
  const sentiment = selectedSentiment(args);
  const minImportance = Number(args.options.minImportance ?? 0);
  const limit = Number(args.options.limit ?? 50);
  const matching = response.items
    .map((item) => mapCloudNewsArticle(item, args.symbols[0]))
    .filter((article) => sentiment === "any" || article.sentiment === sentiment)
    .filter((article) => article.importance >= minImportance)
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime());
  const items = matching.slice(0, limit).map(newsRow);

  return {
    asOf: now.toISOString(),
    items,
    metadata: {
      nextCursor: response.nextCursor,
      sentiment,
      minImportance,
      total: matching.length,
      returned: items.length,
      truncated: items.length < matching.length || response.nextCursor != null,
    },
  };
}

function newsOptions() {
  return [
    {
      key: "sentiment",
      description: "Story sentiment to include.",
      type: "enum" as const,
      values: [
        { value: "any" },
        { value: "positive" },
        { value: "neutral" },
        { value: "negative" },
      ],
      defaultValue: "any",
    },
    {
      key: "minImportance",
      aliases: ["importance"],
      description: "Minimum importance score.",
      type: "integer" as const,
      defaultValue: 0,
      minimum: 0,
      maximum: 100,
    },
    {
      key: "limit",
      description: "Maximum stories to return.",
      type: "integer" as const,
      defaultValue: 50,
      minimum: 1,
      maximum: 200,
    },
  ];
}

function queryFor(args: HeadlessPaneLoadArgs, feed: "latest" | "ticker"): NewsQuery {
  const sentiment = selectedSentiment(args);
  const ticker = args.symbols[0] ? parsePublicTickerKey(args.symbols[0]) : null;
  return {
    feed,
    ...(feed === "ticker"
      ? {
          ticker: ticker?.symbol,
          exchange: ticker?.exchange,
          tickerTier: "primary" as const,
        }
      : {}),
    ...(sentiment === "any" ? {} : { sentiment: sentiment as "positive" | "neutral" | "negative" }),
    minImportance: Number(args.options.minImportance ?? 0),
    limit: Number(args.options.limit ?? 50),
  };
}

export function createNewsFeedHeadless(
  dependencies: NewsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"snapshot"> {
  return {
    shape: "snapshot",
    argument: { kind: "none" },
    options: newsOptions(),
    columns: NEWS_COLUMNS,
    describe: "News Feed",
    async load(args, context) {
      return projectNewsHeadless(
        await dependencies.loadNews(queryFor(args, "latest"), context),
        args,
        dependencies.now(),
      );
    },
  };
}

export function createTickerNewsHeadless(
  dependencies: NewsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"snapshot"> {
  return {
    shape: "snapshot",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Company symbol, optionally qualified as SYMBOL:EXCHANGE.",
    },
    options: newsOptions(),
    columns: NEWS_COLUMNS,
    describe: (args) => `Ticker News | ${String(args.argument)}`,
    async load(args, context) {
      return projectNewsHeadless(
        await dependencies.loadNews(queryFor(args, "ticker"), context),
        args,
        dependencies.now(),
      );
    },
  };
}

export const newsFeedHeadless = createNewsFeedHeadless();
export const tickerNewsHeadless = createTickerNewsHeadless();
