import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessSnapshotResult,
} from "../../../types/plugin";
import type { NewsArticle, NewsQuery } from "../../../news/types";
import {
  coinNewsFallbackNotice,
  mapCloudNewsArticle,
  readCloudNews,
  type CloudNewsRead,
} from "../../../sources/gloomberb-cloud/news";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { companyDataNotes, readCompanyFrom } from "../../../types/company-from";
import { formatUtcSeconds } from "../../../utils/utc-time";
import { cloudNewsFreshness, cloudRealtimeAccess } from "../shared/report-freshness";
import { REPORT_FILTER, REPORT_ROWS } from "../shared/headless-options";

// Stories carry their time to the second, so a story published on a whole minute prints its seconds too.
const NEWS_COLUMNS = [
  { key: "publishedAt", header: "Published", textFormat: formatUtcSeconds },
  { key: "source", header: "Source" },
  { key: "headline", header: "Headline" },
  { key: "tickers", header: "Tickers", textFormat: (value: unknown) => Array.isArray(value) ? value.join(", ") : String(value ?? "") },
  { key: "sentiment", header: "Sentiment" },
  { key: "importance", header: "Score", align: "right" as const },
];

export interface NewsHeadlessDependencies {
  loadNews(
    query: NewsQuery,
    context: HeadlessPaneContext,
  ): Promise<CloudNewsRead>;
  now(): Date;
  /** Whether the session has real-time news; without it the stories are held back. */
  realtimeAccess?(): Promise<boolean | null>;
}

const defaultDependencies: NewsHeadlessDependencies = {
  loadNews: (query, context) => readCloudNews(context.apiClient, query),
  now: () => new Date(),
  realtimeAccess: cloudRealtimeAccess,
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

function projectNewsHeadless(
  response: CloudNewsRead,
  args: HeadlessPaneLoadArgs,
  now: Date,
  realtime: boolean | null,
): HeadlessSnapshotResult {
  const sentiment = selectedSentiment(args);
  const minImportance = Number(args.options.minImportance ?? 0);
  const limit = Number(args.options.limit ?? 50);
  const matching = response.items
    .map((item) => mapCloudNewsArticle(item, response.searchedFor ? undefined : args.symbols[0]))
    .filter((article) => sentiment === "any" || article.sentiment === sentiment)
    .filter((article) => article.importance >= minImportance)
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime());
  const items = matching.slice(0, limit).map(newsRow);

  return {
    asOf: now.toISOString(),
    items,
    // Dated by the newest story, held back for an account without real-time news.
    freshness: cloudNewsFreshness(realtime),
    // A coin pair no story is filed under shows the stories that mention the coin, and says so.
    ...(response.searchedFor && args.symbols[0]
      ? { notes: [coinNewsFallbackNotice(parsePublicTickerKey(args.symbols[0]).symbol, response.searchedFor)] }
      // A receipt's or foreign line's stories are its company's, read from the home line.
      : response.companyFrom ? { notes: companyDataNotes(readCompanyFrom(response.companyFrom)) } : {}),
    metadata: {
      nextCursor: response.nextCursor,
      sentiment,
      minImportance,
      total: matching.length,
      returned: items.length,
      truncated: items.length < matching.length || response.nextCursor != null,
      ...(response.searchedFor ? { searchedFor: response.searchedFor } : {}),
    },
  };
}

function newsOptions() {
  return [
    {
      key: "sentiment",
      shot: REPORT_FILTER,
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
      shot: REPORT_FILTER,
      aliases: ["importance"],
      description: "Minimum importance score.",
      type: "integer" as const,
      defaultValue: 0,
      minimum: 0,
      maximum: 100,
    },
    {
      key: "limit",
      shot: REPORT_ROWS,
      description: "Maximum stories to return.",
      type: "integer" as const,
      defaultValue: 50,
      minimum: 1,
      maximum: 200,
    },
  ];
}

/**
 * A bare symbol listed on several exchanges is ambiguous to the news service.
 * The pane asks with the saved listing's exchange, so the report does too.
 */
async function resolveTicker(
  args: HeadlessPaneLoadArgs,
  context: HeadlessPaneContext,
): Promise<{ symbol: string; exchange?: string } | null> {
  const key = args.symbols[0];
  if (!key) return null;
  const parsed = parsePublicTickerKey(key);
  if (parsed.exchange || !context.resolveInstrument) return parsed;
  const saved = await context.resolveInstrument(key);
  return { symbol: parsed.symbol, exchange: saved.exchange || undefined };
}

function queryFor(
  args: HeadlessPaneLoadArgs,
  feed: "latest" | "ticker",
  ticker: { symbol: string; exchange?: string } | null = null,
): NewsQuery {
  const sentiment = selectedSentiment(args);
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
        await dependencies.realtimeAccess?.() ?? null,
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
        await dependencies.loadNews(
          queryFor(args, "ticker", await resolveTicker(args, context)),
          context,
        ),
        args,
        dependencies.now(),
        await dependencies.realtimeAccess?.() ?? null,
      );
    },
  };
}

export const newsFeedHeadless = createNewsFeedHeadless();
export const tickerNewsHeadless = createTickerNewsHeadless();
