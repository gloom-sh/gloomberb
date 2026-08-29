import type { CloudTweetQueryType } from "./types";
import { normalizeSymbol, publicTickerKey } from "../utils/exchanges";

export type CloudHistoryParams = {
  interval?: string;
  outputsize?: number;
  startDate?: string;
  endDate?: string;
  rangeKey?: string;
};

export type CloudFredSeriesParams = {
  startDate?: string;
  endDate?: string;
  limit?: number;
  sortOrder?: "asc" | "desc";
};

export type CloudCdsParams = {
  /** Reference entity name, matched by the backend against DTCC issuer names. */
  issuer?: string;
  days?: number;
  limit?: number;
};

export type CloudCongressHouseParams = {
  year?: number;
  limit?: number;
  offset?: number;
  filingLimit?: number;
  filingOffset?: number;
  member?: string;
  ticker?: string;
  refresh?: boolean;
};

export type CloudNewsParams = {
  feed?: "latest" | "top" | "breaking" | "ticker" | "sector" | "topic";
  ticker?: string;
  exchange?: string;
  tickerTier?: "primary" | "related" | "any";
  tickerRelations?: string[];
  limit?: number;
  topics?: string[];
  categories?: string[];
  sectors?: string[];
  sources?: string[];
  excludeSources?: string[];
  sentiment?: "positive" | "neutral" | "negative";
  minImportance?: number;
  minUrgency?: number;
  breaking?: boolean;
  since?: Date;
  until?: Date;
  cursor?: string;
};

export type CloudTickerTweetsParams = {
  ticker: string;
  limit?: number;
  hours?: number;
  includeReplies?: boolean;
};

export type CloudTweetSearchParams = {
  query: string;
  queryType?: CloudTweetQueryType;
  limit?: number;
  hours?: number;
};

const LOGO_SYMBOL_RE = /^[A-Z0-9][A-Z0-9._^:-]{0,23}$/;
const CRYPTO_QUOTE = /[-/](USD|USDT|USDC|EUR|GBP|BTC)$/;

export type CloudLogoKind = "ticker" | "crypto";

export function normalizeCloudLogoSymbol(kind: CloudLogoKind, symbol: string): string | null {
  let normalized = symbol.trim().toUpperCase();
  if (kind === "crypto") normalized = normalized.replace(CRYPTO_QUOTE, "");
  return LOGO_SYMBOL_RE.test(normalized) ? normalized : null;
}

export function cloudLogoPath(kind: CloudLogoKind, symbol: string): string | null {
  const normalized = normalizeCloudLogoSymbol(kind, symbol);
  if (!normalized) return null;
  return `/cloud/logos/${kind}/${encodeURIComponent(normalized)}`;
}

function appendQuery(path: string, search: URLSearchParams): string {
  const query = search.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

export function cloudMarketSearchPath(query: string, limit: number): string {
  return appendQuery("/market/search", new URLSearchParams({
    q: query,
    limit: String(limit),
  }));
}

export function cloudMarketSymbolPath(path: string, symbol: string, exchange?: string): string {
  const search = new URLSearchParams({ symbol });
  if (exchange) search.set("exchange", exchange);
  return appendQuery(path, search);
}

export function cloudOptionsChainPath(symbol: string, exchange?: string, expirationDate?: number): string {
  const search = new URLSearchParams({ symbol });
  if (exchange) search.set("exchange", exchange);
  if (expirationDate != null) search.set("expirationDate", String(expirationDate));
  return appendQuery("/market/options", search);
}

export function cloudStatementsPath(
  symbol: string,
  exchange: string | undefined,
  period: "annual" | "quarterly" | "both",
): string {
  const search = new URLSearchParams({ symbol, period });
  if (exchange) search.set("exchange", exchange);
  return appendQuery("/market/statements", search);
}

export function cloudHistoryPath(symbol: string, exchange: string, params: CloudHistoryParams = {}): string {
  const search = new URLSearchParams({ symbol, exchange });
  if (params.interval) search.set("interval", params.interval);
  if (params.outputsize != null) search.set("outputsize", String(params.outputsize));
  if (params.startDate) search.set("startDate", params.startDate);
  if (params.endDate) search.set("endDate", params.endDate);
  if (params.rangeKey) search.set("rangeKey", params.rangeKey);
  return appendQuery("/market/history", search);
}

export function cloudExchangeRatePath(fromCurrency: string): string {
  return appendQuery("/market/exchange-rate", new URLSearchParams({ fromCurrency }));
}

export function cloudFredSeriesPath(seriesId: string, params: CloudFredSeriesParams = {}): string {
  const search = new URLSearchParams();
  if (params.startDate) search.set("startDate", params.startDate);
  if (params.endDate) search.set("endDate", params.endDate);
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.sortOrder) search.set("sortOrder", params.sortOrder);
  return appendQuery(`/cloud/econ/series/${encodeURIComponent(seriesId)}`, search);
}

export function cloudCdsPath(params: CloudCdsParams = {}): string {
  const search = new URLSearchParams();
  const issuer = params.issuer?.trim();
  if (issuer) search.set("issuer", issuer);
  if (params.days != null) search.set("days", String(params.days));
  if (params.limit != null) search.set("limit", String(params.limit));
  return appendQuery("/cloud/credit/cds", search);
}

export type CloudSecFilingsParams = {
  ticker: string;
  limit?: number;
  offset?: number;
};

export type CloudSecFilingParams = {
  cik?: string;
  accession?: string;
  form?: string;
  primaryDocument?: string;
  primaryDocumentUrl?: string;
  filingUrl?: string;
};

export function cloudCongressHousePath(params: CloudCongressHouseParams = {}): string {
  const search = new URLSearchParams();
  if (params.year != null) search.set("year", String(params.year));
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  if (params.filingLimit != null) search.set("filingLimit", String(params.filingLimit));
  if (params.filingOffset != null) search.set("filingOffset", String(params.filingOffset));
  if (params.member) search.set("member", params.member);
  if (params.ticker) search.set("ticker", params.ticker);
  if (params.refresh != null) search.set("refresh", String(params.refresh));
  return appendQuery("/cloud/congress/house", search);
}

export function cloudSecFilingsPath(params: CloudSecFilingsParams): string {
  const search = new URLSearchParams({ ticker: params.ticker });
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  return appendQuery("/cloud/sec/filings", search);
}

export function cloudSecFilingDocumentsPath(params: CloudSecFilingParams): string {
  const search = new URLSearchParams();
  if (params.cik) search.set("cik", params.cik);
  if (params.accession) search.set("accession", params.accession);
  if (params.form) search.set("form", params.form);
  if (params.primaryDocument) search.set("primaryDocument", params.primaryDocument);
  if (params.filingUrl) search.set("filingUrl", params.filingUrl);
  return appendQuery("/cloud/sec/filing/documents", search);
}

export function cloudSecFilingContentPath(params: CloudSecFilingParams): string {
  const search = new URLSearchParams();
  if (params.cik) search.set("cik", params.cik);
  if (params.accession) search.set("accession", params.accession);
  if (params.form) search.set("form", params.form);
  if (params.primaryDocument) search.set("primaryDocument", params.primaryDocument);
  if (params.primaryDocumentUrl) search.set("primaryDocumentUrl", params.primaryDocumentUrl);
  if (params.filingUrl) search.set("filingUrl", params.filingUrl);
  return appendQuery("/cloud/sec/filing/content", search);
}

export function cloudSec13FPath(path: string, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return appendQuery(`/cloud/sec/13f/${normalized}`, search);
}

export function cloudNewsPath(params: CloudNewsParams = {}): string {
  const search = new URLSearchParams();
  if (params.feed) search.set("feed", params.feed);
  if (params.ticker) {
    const tickerFilter = params.exchange
      ? publicTickerKey(params.ticker, params.exchange)
      : normalizeSymbol(params.ticker);
    search.set("tickers", tickerFilter);
  }
  if (params.tickerTier) search.set("tickerTier", params.tickerTier);
  if (params.tickerRelations?.length) search.set("tickerRelations", params.tickerRelations.join(","));
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.topics?.length) search.set("topics", params.topics.join(","));
  if (params.categories?.length) search.set("categories", params.categories.join(","));
  if (params.sectors?.length) search.set("sectors", params.sectors.join(","));
  if (params.sources?.length) search.set("sources", params.sources.join(","));
  if (params.excludeSources?.length) search.set("excludeSources", params.excludeSources.join(","));
  if (params.sentiment) search.set("sentiment", params.sentiment);
  if (params.minImportance != null) search.set("minImportance", String(params.minImportance));
  if (params.minUrgency != null) search.set("minUrgency", String(params.minUrgency));
  if (params.breaking != null) search.set("breaking", String(params.breaking));
  if (params.since) search.set("since", params.since.toISOString());
  if (params.until) search.set("until", params.until.toISOString());
  if (params.cursor) search.set("cursor", params.cursor);
  return appendQuery("/news", search);
}

export function cloudNewsSearchPath(query: string, limit: number): string {
  return appendQuery("/news/search", new URLSearchParams({
    query,
    limit: String(limit),
  }));
}

export function cloudTickerTweetsPath(params: CloudTickerTweetsParams): string {
  const search = new URLSearchParams({ ticker: params.ticker });
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.hours != null) search.set("hours", String(params.hours));
  if (params.includeReplies != null) search.set("includeReplies", String(params.includeReplies));
  return appendQuery("/news/tweets", search);
}

export function cloudTweetSearchPath(params: CloudTweetSearchParams): string {
  const search = new URLSearchParams({ query: params.query });
  if (params.queryType) search.set("queryType", params.queryType);
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.hours != null) search.set("hours", String(params.hours));
  return appendQuery("/news/tweets/search", search);
}
