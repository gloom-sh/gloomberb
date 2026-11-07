import { normalizeNewsFeed } from "../../news/news-model";
import { readableNewsSource } from "../../news/source-label";
import { collectNewsDisplayTickers } from "../../news/ticker-symbols";
import type { NewsAccess, NewsArticle, NewsQuery, NewsStoryItem } from "../../types/news-source";
import { CLOUD_NEWS_DELAY_HOURS } from "../../api-client/plan-rules";
import type {
  apiClient,
  CloudNewsListResponse,
  CloudNewsPayload,
  CloudNewsStoryItemPayload,
} from "../../api-client";
import type { CloudNewsParams } from "../../api-client/paths";
import { parsePublicTickerKey, publicExchange } from "../../utils/exchanges";
import { coinSearchName } from "../../utils/crypto-pair";
import { commoditySearchName } from "../../market-data/commodity-names";
import { futuresBoardContractForTicker } from "../../market-data/futures-board";
import { logFailure } from "../../utils/log-failure";
import { getListingSymbol, tickerHasListingSuffix } from "../listing-symbols";

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

type CloudNewsTickerLink = CloudNewsPayload["tickerLinks"][number];

const statesMarketCap = (link: CloudNewsTickerLink) => typeof link.marketCap === "number" && link.marketCap > 0;

/**
 * One link a company: a symbol a story tags on several venues (ASML on
 * Euronext Amsterdam and on NASDAQ) keeps its home listing, the line Gloom
 * Cloud states the company's market cap on, else the venue tagged first. The
 * tag stays where the company was first tagged.
 */
function homeListingLinks(links: readonly CloudNewsTickerLink[]): CloudNewsTickerLink[] {
  const companies = new Map<string, CloudNewsTickerLink>();
  links.forEach((link, index) => {
    const symbol = link.symbol?.trim().toUpperCase() || `#${index}`;
    const kept = companies.get(symbol);
    if (!kept || (!statesMarketCap(kept) && statesMarketCap(link))) companies.set(symbol, link);
  });
  return [...companies.values()];
}

function mapCloudNewsTickers(
  item: CloudNewsPayload,
  fallbackTicker?: string,
): string[] {
  // Each company's listing: its canonical key, or its symbol on its venue.
  const tickers = collectNewsDisplayTickers(homeListingLinks(item.tickerLinks).map((link) => (
    link.canonicalTicker || (link.symbol && link.exchange ? `${link.symbol}:${link.exchange}` : link.symbol)
  )));
  const fallbackTickers = collectNewsDisplayTickers([fallbackTicker]);
  if (tickers.length === 0) tickers.push(...fallbackTickers);
  return tickers;
}

function mapCloudNewsStoryItem(
  item: CloudNewsStoryItemPayload,
): NewsStoryItem {
  const publishedAt = new Date(item.publishedAt);
  return {
    id: item.id,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName || readableNewsSource(item.sourceKey),
    title: item.title,
    summary: item.summary,
    url: item.url,
    publishedAt: Number.isNaN(publishedAt.getTime())
      ? new Date(0)
      : publishedAt,
    hasArticleText: item.hasArticleText,
  };
}

export function mapCloudNewsArticle(
  item: CloudNewsPayload,
  fallbackTicker?: string,
): NewsArticle {
  const publishedAt = new Date(
    item.lastPublishedAt || item.firstPublishedAt || item.lastSeenAt,
  );
  const topic = item.topic ?? item.category ?? "general";
  const topics = uniqueStrings([topic, ...normalizeStringArray(item.topics)]);
  const sectors = normalizeStringArray(item.sectors);
  const scores = {
    importance: item.scores?.importance ?? 0,
    urgency: item.scores?.urgency ?? 0,
    marketImpact: item.scores?.marketImpact ?? 0,
    novelty: item.scores?.novelty ?? 0,
    confidence: item.scores?.confidence ?? 0,
  };
  const tickers = mapCloudNewsTickers(item, fallbackTicker);
  // primarySource is the cloud's routing key ("prnewswire-americas"); readers
  // see the publisher the service names, or the story item it points at.
  const primaryItem = item.items?.find((entry) => entry.sourceKey === item.primarySource);
  return {
    id: item.id,
    title: item.headline,
    url: item.primaryUrl,
    source: item.primaryPublisher
      || primaryItem?.sourceName
      || readableNewsSource(item.primarySource),
    publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date(0) : publishedAt,
    summary: item.summary,
    topic,
    topics,
    sectors,
    categories: uniqueStrings([...topics, ...sectors]),
    tickers,
    sentiment: item.sentiment,
    scores,
    importance: scores.importance,
    isBreaking: !!item.flags?.breaking,
    isDeveloping: !!item.flags?.developing,
    sourceCount: item.sourceCount,
    items: item.items?.map(mapCloudNewsStoryItem) ?? [],
  };
}

export function cloudNewsParams(query: NewsQuery): CloudNewsParams {
  const feed = normalizeNewsFeed(query);
  const ticker = query.ticker ? parsePublicTickerKey(query.ticker) : undefined;
  const exchange = ticker?.exchange ?? query.exchange;
  let symbol = ticker?.symbol;
  if (symbol && exchange && tickerHasListingSuffix(symbol)) {
    const baseSymbol = symbol.slice(0, symbol.lastIndexOf("."));
    if (getListingSymbol(baseSymbol, exchange) === symbol) symbol = baseSymbol;
  }
  return {
    feed,
    ticker: feed === "ticker" ? symbol : undefined,
    exchange: feed === "ticker" ? publicExchange(exchange) : undefined,
    tickerTier:
      feed === "ticker" ? query.tickerTier ?? "primary" : query.tickerTier,
    tickerRelations: query.tickerRelations,
    limit: query.limit,
    topics: query.topics,
    categories: query.topics ? undefined : query.categories,
    sectors: query.sectors,
    sources: query.sources,
    excludeSources: query.excludeSources,
    sentiment: query.sentiment,
    minImportance: query.minImportance,
    minUrgency: query.minUrgency,
    breaking: query.breaking,
    since: query.since,
    until: query.until,
    cursor: query.cursor,
  };
}

/**
 * A page of Gloom Cloud stories, with the text searched for when a coin pair's
 * feed had none filed under it, and which news the service answered with.
 */
export type CloudNewsRead = Omit<CloudNewsListResponse, "access"> & { searchedFor?: string; access?: NewsAccess | null };

/**
 * How recently the service must have seen a story for the answer to be the
 * live wire. It holds a story back from an account without real-time news
 * until it last saw it {@link CLOUD_NEWS_DELAY_HOURS} hours ago; the hour
 * less leaves room for this clock and the service's to disagree.
 */
const LIVE_STORY_WINDOW_MS = (CLOUD_NEWS_DELAY_HOURS - 1) * 60 * 60 * 1000;

/**
 * Which news a Gloom Cloud answer is, from the answer: what the service says
 * when it says it; held back when the request carried no session, since the
 * service holds news back for anyone it cannot name; live when it holds a
 * story seen too recently to have been held back. Otherwise null: a quiet
 * feed read live looks the same as a held-back one.
 */
export function cloudNewsAccess(
  response: Pick<CloudNewsListResponse, "items" | "access">,
  sentSession: boolean,
  now = Date.now(),
): NewsAccess | null {
  if (response.access === "realtime" || response.access === "delayed") return response.access;
  if (!sentSession) return "delayed";
  const live = response.items.some((item) => {
    const seenAt = Date.parse(item.lastSeenAt);
    return Number.isFinite(seenAt) && now - seenAt < LIVE_STORY_WINDOW_MS;
  });
  return live ? "realtime" : null;
}

/** A client that cannot say whether a session goes with its requests (a test double) is taken to send one. */
type CloudNewsClient = Pick<typeof apiClient, "getCloudNews" | "searchCloudNews">
  & Partial<Pick<typeof apiClient, "hasSessionCredential">>;

/** The NI code of the metal markets: prices, futures, bullion and the trusts that hold it, not a miner's releases. */
export const METALS_NEWS_TOPIC = "metals";
/** The topic the service tags oil, gas and power market stories with. */
export const ENERGY_NEWS_TOPIC = "energy";

/**
 * What a ticker no story is filed under is searched by: a coin pair's coin
 * ("bitcoin" for BTC-USD), or a futures board symbol's commodity ("cocoa" for
 * CC=F), as `news` searches them. A metal's future (GC=F, SI=F, HG=F, PL=F,
 * PA=F, ALI=F) searches the metals stories only, as `news GC=F` does: the
 * stories that merely name gold are mostly miners' releases. Null for
 * anything else, and for a future with no commodity name (ES=F, ZN=F).
 */
function newsFallbackSearch(query: Pick<NewsQuery, "ticker" | "exchange" | "listingName">): { text: string; topics?: string[] } | null {
  const coin = coinSearchName(query.ticker, query.exchange, query.listingName);
  if (coin) return { text: coin };
  const future = query.ticker ? futuresBoardContractForTicker(parsePublicTickerKey(query.ticker).symbol) : null;
  const text = future ? commoditySearchName(future) : null;
  if (!future || !text) return null;
  return future.sector === "metals" ? { text, topics: [METALS_NEWS_TOPIC] } : { text };
}

/**
 * A news query's first page from Gloom Cloud. Stories are filed under company
 * tickers, and a coin pair (BTC-USD) or a future (CC=F) rarely has any filed
 * under it, so its empty feed falls back to the stories that mention the coin
 * or the commodity ("bitcoin", "cocoa"), marked with what was searched. A
 * later page, a failed search or a ticker with no name to search keeps the
 * empty answer.
 */
export async function readCloudNews(client: CloudNewsClient, query: NewsQuery): Promise<CloudNewsRead> {
  // Asked in the tick the request goes out in, which is when its headers take the session.
  const sentSession = client.hasSessionCredential?.() ?? true;
  const response = await client.getCloudNews(cloudNewsParams(query));
  const read: CloudNewsRead = { ...response, access: cloudNewsAccess(response, sentSession) };
  if (response.items.length > 0 || query.cursor || normalizeNewsFeed(query) !== "ticker") return read;
  const search = newsFallbackSearch(query);
  if (!search) return read;
  const found = await client.searchCloudNews(search.text, query.limit, search.topics)
    .catch(logFailure("sources.gloomberb-cloud.news", "Search the stories that mention a ticker's coin or commodity failed", null));
  return found && found.items.length > 0
    ? { items: found.items, nextCursor: null, searchedFor: search.text, access: cloudNewsAccess(found, sentSession) }
    : read;
}

/** A read's stories as articles, each marked with the text a coin's or a future's fallback searched for. */
export function cloudNewsReadArticles(read: CloudNewsRead, ticker?: string): NewsArticle[] {
  return read.items.map((item) => {
    const article = mapCloudNewsArticle(item, read.searchedFor ? undefined : ticker);
    return read.searchedFor ? { ...article, searchedFor: read.searchedFor } : article;
  });
}

/** What a pane or report says above the stories a fallback found: "No stories are filed under CC=F; these mention cocoa." */
export function newsFallbackNotice(ticker: string, searchedFor: string): string {
  return `No stories are filed under ${ticker}; these mention ${searchedFor}.`;
}
