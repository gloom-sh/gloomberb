import type {
  CloudSearchDocType,
  CloudSearchSort,
  CloudTweetQueryType,
} from "./types";
import { isUsListingExchange, normalizeSymbol, parsePublicTickerKey, publicTickerKey } from "../utils/exchanges";
import { nonUsSecListingVenue } from "../utils/sec";
import type { HistoryRetention } from "../sources/history-retention";
import type { CloudBeneficialOwnersParams } from "./beneficial-owners";
import type { CloudInsiderSignalsParams } from "./insider-signals";
import { reportedRevenueVenue, type RevenueBreakdownView } from "./revenue-breakdown";

export type CloudHistoryParams = {
  interval?: string;
  outputsize?: number;
  startDate?: string;
  endDate?: string;
  rangeKey?: string;
  historyRecovery?: HistoryRetention;
  /** Ask for pre-market and after-hours bars too. */
  session?: "extended";
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

export type CloudCdsHistoryParams = {
  /** Company name; the backend matches it to one reference entity. */
  issuer: string;
  days?: number;
};

type CloudCongressChamber = "all" | "house" | "senate";

export type CloudCongressHouseParams = {
  /** Which feed to read; House when omitted. */
  chamber?: CloudCongressChamber;
  year?: number;
  limit?: number;
  offset?: number;
  filingLimit?: number;
  filingOffset?: number;
  member?: string;
  ticker?: string;
  refresh?: boolean;
  side?: "BUY" | "SELL" | "EXCHANGE" | "OTHER";
  owner?: "self" | "spouse" | "joint" | "dependent" | "other";
  assetType?: "stock" | "option" | "other";
  minAmount?: number;
};

/** The listing an issuer lookup is for, so a listing abroad never reads a US namesake. */
export type IssuerListingParams = {
  /** The listing's venue. Sent only for a venue outside the US, with `name`. */
  exchange?: string;
  /** The listing's company name, from its ticker or its own quote. */
  name?: string;
};

export type CloudEarningsCallsParams = IssuerListingParams & {
  ticker?: string;
  limit?: number;
  offset?: number;
  /** Include calls still working through the transcription pipeline. */
  includePending?: boolean;
  /** Every company's calls on these New York days (YYYY-MM-DD), earliest first, in place of a company or the shelf. */
  upcoming?: { from: string; to: string };
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
  offset?: number;
  hours?: number;
  includeReplies?: boolean;
};

export type CloudTweetSearchParams = {
  query: string;
  queryType?: CloudTweetQueryType;
  limit?: number;
  offset?: number;
  hours?: number;
};

const LOGO_SYMBOL_RE = /^[A-Z0-9][A-Z0-9._^:-]{0,23}$/;
const CRYPTO_QUOTE = /[-/](USD|USDT|USDC|EUR|GBP|BTC)$/;

export type CloudLogoKind = "ticker" | "crypto";

function normalizeCloudLogoSymbol(
  kind: CloudLogoKind,
  symbol: string,
): string | null {
  let normalized = symbol.trim().toUpperCase();
  // A coin is its code alone: BTC-USD:CCC and BTC/USDT are both BTC.
  if (kind === "crypto") normalized = parsePublicTickerKey(normalized).symbol.replace(CRYPTO_QUOTE, "");
  return LOGO_SYMBOL_RE.test(normalized) ? normalized : null;
}

export function cloudLogoPath(
  kind: CloudLogoKind,
  symbol: string,
): string | null {
  const normalized = normalizeCloudLogoSymbol(kind, symbol);
  if (!normalized) return null;
  return `/cloud/logos/${kind}/${encodeURIComponent(normalized)}`;
}

function appendQuery(path: string, search: URLSearchParams): string {
  const query = search.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

export type QueryParamValue = string | number | boolean | null | undefined;

/** Appends defined, non-null entries to `path` as `?a=1&b=2`; omits `?` when empty. */
export function queryPath(
  path: string,
  params: Record<string, QueryParamValue> | object,
  options?: { skipEmpty?: boolean },
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (options?.skipEmpty && value === "") continue;
    search.set(key, String(value));
  }
  return appendQuery(path, search);
}

/**
 * `deep`: the search waits for a venue's own site (the CLI's), which a search
 * box's keystroke gives about a second.
 */
export function cloudMarketSearchPath(query: string, limit: number, deep = false): string {
  return queryPath("/market/search", { q: query, limit, deep: deep ? "1" : undefined });
}

export function cloudMarketSymbolPath(path: string, symbol: string, exchange?: string): string {
  return queryPath(path, { symbol, exchange: exchange || undefined });
}

export function cloudOptionsChainPath(
  symbol: string,
  exchange?: string,
  expirationDate?: number,
  /** The contracts adjusted for a corporate action, in place of the standard ones. */
  adjusted = false,
): string {
  return queryPath("/market/options", {
    symbol,
    exchange: exchange || undefined,
    expirationDate,
    adjusted: adjusted ? "1" : undefined,
  });
}

export function cloudHistoryPath(symbol: string, exchange: string, params: CloudHistoryParams = {}): string {
  return queryPath("/market/history", {
    symbol,
    exchange,
    interval: params.interval || undefined,
    outputsize: params.outputsize,
    startDate: params.startDate || undefined,
    endDate: params.endDate || undefined,
    rangeKey: params.rangeKey || undefined,
    historyRecovery: params.historyRecovery ? JSON.stringify(params.historyRecovery) : undefined,
    session: params.session || undefined,
  });
}

export function cloudShillerPath(): string {
  return "/cloud/econ/shiller";
}

export function cloudExchangeRatePath(fromCurrency: string): string {
  return queryPath("/market/exchange-rate", { fromCurrency });
}

export function cloudFredSeriesPath(seriesId: string, params: CloudFredSeriesParams = {}): string {
  return queryPath(`/cloud/econ/series/${encodeURIComponent(seriesId)}`, {
    startDate: params.startDate || undefined,
    endDate: params.endDate || undefined,
    limit: params.limit,
    sortOrder: params.sortOrder || undefined,
  });
}

export function cloudCdsPath(params: CloudCdsParams = {}): string {
  return queryPath("/cloud/credit/cds", {
    issuer: params.issuer?.trim() || undefined,
    days: params.days,
    limit: params.limit,
  });
}

export function cloudCdsHistoryPath(params: CloudCdsHistoryParams): string {
  return queryPath("/cloud/credit/cds/history", { issuer: params.issuer.trim(), days: params.days });
}

/** `/cloud/credit/cdx` or `/cloud/credit/sovr`. */
export function cloudCreditBoardPath(board: "cdx" | "sovr", params: { days?: number } = {}): string {
  return queryPath(`/cloud/credit/${board}`, { days: params.days });
}

export type CloudSecFilingsParams = {
  proceedsSince?: string;
  ticker: string;
  /** The listing's venue. Sent only for a venue outside the US, with `name`. */
  exchange?: string;
  /** The listing's company name, from its own quote. */
  name?: string;
  limit?: number;
  offset?: number;
  /** Only these forms, each with its amendment (`8-K` is also `8-K/A`). A server that predates the filter sends every form. */
  forms?: readonly string[];
  /** Also the newest filing day of each form the whole list holds (`newestByForm`), whatever the page's forms. */
  newestByForm?: boolean;
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
  return queryPath(`/cloud/congress/${params.chamber ?? "house"}`, {
    year: params.year,
    limit: params.limit,
    offset: params.offset,
    filingLimit: params.filingLimit,
    filingOffset: params.filingOffset,
    member: params.member || undefined,
    ticker: params.ticker || undefined,
    side: params.side || undefined,
    owner: params.owner || undefined,
    assetType: params.assetType || undefined,
    minAmount: params.minAmount,
    refresh: params.refresh,
  });
}

/** Issuer endpoints accept US ticker symbols, not the pane's listing key. */
export function normalizeIssuerResearchTicker(ticker: string): string {
  const parsed = parsePublicTickerKey(ticker);
  return isUsListingExchange(parsed.exchange) ? parsed.symbol : normalizeSymbol(ticker);
}

export function cloudJobsPath(ticker: string, name?: string | null): string {
  return queryPath(`/cloud/jobs/${encodeURIComponent(normalizeIssuerResearchTicker(ticker))}`, { name: name || undefined });
}

export interface CloudJobsPostingsParams {
  function?: string;
  q?: string;
  limit?: number;
  offset?: number;
  includeClosed?: boolean;
}

export function cloudJobsPostingsPath(ticker: string, params: CloudJobsPostingsParams = {}): string {
  return queryPath(`/cloud/jobs/${encodeURIComponent(normalizeIssuerResearchTicker(ticker))}/postings`, {
    function: params.function || undefined,
    q: params.q || undefined,
    limit: params.limit,
    offset: params.offset,
    includeClosed: params.includeClosed ? "true" : undefined,
  });
}

/** One posting of a company, by the database id the jobs list carries or the careers system's own id HIRE's evidence carries. */
export function cloudJobsPostingPath(ticker: string, posting: { id: number } | { externalId: string }): string {
  return queryPath(
    `/cloud/jobs/${encodeURIComponent(normalizeIssuerResearchTicker(ticker))}/posting`,
    "id" in posting ? { id: posting.id } : { externalId: posting.externalId },
  );
}

export function cloudJobsMoversPath(limit?: number, offset?: number): string {
  return queryPath("/cloud/jobs", { limit, offset: offset || undefined });
}

/** A listing outside the US, as an issuer lookup names it: its bare symbol, venue and company. */
export interface ListingAbroad {
  symbol: string;
  exchange: string;
  name?: string;
}

/**
 * The listing abroad a ticker names, from its key or the given venue: AI in
 * Paris is Air Liquide, AI in New York is C3.ai. Null for a US listing, a
 * routing destination or a symbol with no venue, which keep their US lookup.
 */
export function listingAbroad(ticker: string, exchange?: string, name?: string | null): ListingAbroad | null {
  const venue = nonUsSecListingVenue(ticker, exchange);
  if (!venue) return null;
  const company = name?.trim();
  return { symbol: parsePublicTickerKey(ticker).symbol, exchange: venue, ...(company ? { name: company } : {}) };
}

/** Query entries for a listing abroad (empty for a US listing). */
function listingAbroadParams(listing: ListingAbroad | null): Record<string, QueryParamValue> {
  return listing ? { exchange: listing.exchange, name: listing.name } : {};
}

/** A US listing or a bare symbol looks up its US ticker as before; a listing abroad names its venue and company. */
export function cloudEarningsCallsPath(params: CloudEarningsCallsParams = {}): string {
  const abroad = params.ticker ? listingAbroad(params.ticker, params.exchange, params.name) : null;
  return queryPath("/cloud/transcripts", {
    ...(params.ticker ? { ticker: abroad?.symbol ?? normalizeIssuerResearchTicker(params.ticker), ...listingAbroadParams(abroad) } : {}),
    limit: params.limit,
    offset: params.offset,
    includePending: params.includePending ? "true" : undefined,
    ...(params.upcoming ? { upcoming: "true", from: params.upcoming.from, to: params.upcoming.to } : {}),
  });
}

export function cloudEarningsTranscriptPath(id: string): string {
  return `/cloud/transcripts/${encodeURIComponent(id)}`;
}

export function cloudEarningsCallAudioPath(id: string): string {
  return `${cloudEarningsTranscriptPath(id)}/audio`;
}

/**
 * An issuer read's path: a US listing or a bare symbol keeps its US ticker
 * and sends nothing else; a listing abroad sends its bare symbol with its
 * venue and company (listingAbroad).
 */
function issuerPath(base: string, ticker: string, listing: IssuerListingParams = {}, suffix = "", extra?: Record<string, QueryParamValue>): string {
  const abroad = listingAbroad(ticker, listing.exchange, listing.name);
  return queryPath(
    `${base}/${encodeURIComponent(abroad?.symbol ?? normalizeIssuerResearchTicker(ticker))}${suffix}`,
    { ...listingAbroadParams(abroad), ...extra },
  );
}

/**
 * RISK, EXEC and EK are Pro: these reads need a verified Pro account. The same
 * risk factors and pay are open under /public for the gloom.sh pages.
 */
export function cloudProxyStatementsPath(ticker: string, listing?: IssuerListingParams): string {
  return issuerPath("/cloud/proxies", ticker, listing);
}

export function cloudFilingEventsPath(ticker: string, limit?: number, listing: IssuerListingParams = {}): string {
  return issuerPath("/cloud/events", ticker, listing, "", { limit });
}

export function cloudRiskReportsPath(ticker: string, listing?: IssuerListingParams): string {
  return issuerPath("/cloud/risks", ticker, listing);
}

export function cloudRiskReportPath(ticker: string, year: number, listing?: IssuerListingParams): string {
  return issuerPath("/cloud/risks", ticker, listing, `/${year}`);
}

export function cloudProxyStatementPath(ticker: string, year: number, listing?: IssuerListingParams): string {
  return issuerPath("/cloud/proxies", ticker, listing, `/${year}`);
}

/**
 * The maturity schedule; a US symbol goes as given, as it always has.
 * `version=2` asks for schedules in a filing's own bands too, which servers
 * before them ignore.
 */
export function cloudDebtMaturitiesPath(symbol: string, listing: IssuerListingParams = {}): string {
  const abroad = listingAbroad(symbol, listing.exchange, listing.name);
  return queryPath("/cloud/debt-maturities", { symbol: abroad?.symbol ?? symbol, ...listingAbroadParams(abroad), version: "2" });
}

export function cloudRevenueBreakdownPath(symbol: string, view?: RevenueBreakdownView, listing: IssuerListingParams = {}): string {
  const abroad = listingAbroad(symbol, listing.exchange, listing.name);
  return queryPath("/cloud/revenue-breakdown", {
    symbol: abroad?.symbol ?? symbol,
    ...listingAbroadParams(abroad),
    view: view || undefined,
    periods: reportedRevenueVenue(abroad?.exchange) ? "reported" : undefined,
  });
}

/**
 * A US listing, or a symbol with no venue, looks up its US ticker as before.
 * A listing elsewhere sends its bare symbol with the venue and company name:
 * its symbol can be another company's US ticker.
 */
export function cloudSecFilingsPath(params: CloudSecFilingsParams): string {
  const abroad = listingAbroad(params.ticker, params.exchange, params.name);
  return queryPath("/cloud/sec/filings", {
    ticker: abroad?.symbol ?? normalizeIssuerResearchTicker(params.ticker),
    limit: params.limit,
    offset: params.offset,
    form: params.forms?.length ? params.forms.join(",") : undefined,
    proceedsSince: params.proceedsSince || undefined,
    newestByForm: params.newestByForm ? "1" : undefined,
    ...listingAbroadParams(abroad),
  });
}

/** A US-listed company's bank figures: SEC deposits and its lead bank's FDIC call report. */
export function cloudBankFiguresPath(symbol: string): string {
  return queryPath("/cloud/bank-figures", { symbol });
}

/** Schedule 13D and 13G reports about the issuer behind `ticker`. */
export function cloudSecBeneficialOwnersPath(params: CloudBeneficialOwnersParams): string {
  const abroad = listingAbroad(params.ticker, params.exchange, params.name);
  return queryPath("/cloud/sec/beneficial-owners", {
    ticker: abroad?.symbol ?? normalizeIssuerResearchTicker(params.ticker),
    ...listingAbroadParams(abroad),
    form: params.form || undefined,
    history: params.history ? "1" : undefined,
    limit: params.limit,
    offset: params.offset,
  });
}

/** Companies ranked by recent open-market insider buying or selling. Defaults are left out of the query. */
export function cloudSecInsiderSignalsPath(params: CloudInsiderSignalsParams = {}): string {
  return queryPath("/cloud/sec/insider-signals", {
    side: params.side === "sell" ? "sell" : undefined,
    window: params.window,
    limit: params.limit,
    role: params.role && params.role !== "all" ? params.role : undefined,
    minValue: params.minValue || undefined,
    cluster: params.cluster ? "true" : undefined,
    position: params.position || undefined,
    cap: params.cap || undefined,
    ticker: params.ticker || undefined,
  });
}

function secFilingPath(endpoint: string, params: CloudSecFilingParams, includePrimaryUrl: boolean): string {
  return queryPath(endpoint, {
    cik: params.cik || undefined,
    accession: params.accession || undefined,
    form: params.form || undefined,
    primaryDocument: params.primaryDocument || undefined,
    primaryDocumentUrl: includePrimaryUrl ? params.primaryDocumentUrl || undefined : undefined,
    filingUrl: params.filingUrl || undefined,
  });
}

export function cloudSecFilingDocumentsPath(params: CloudSecFilingParams): string {
  return secFilingPath("/cloud/sec/filing/documents", params, false);
}

export function cloudSecFilingContentPath(params: CloudSecFilingParams): string {
  return secFilingPath("/cloud/sec/filing/content", params, true);
}

export function cloudSec13FPath(
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return queryPath(`/cloud/sec/13f/${normalized}`, params);
}

export type CloudSearchParams = {
  query: string;
  tickers?: readonly string[];
  docTypes?: readonly CloudSearchDocType[];
  sources?: readonly string[];
  /** Inclusive ISO date or timestamp bounds on `publishedAt`. */
  from?: string;
  to?: string;
  sort?: CloudSearchSort;
  limit?: number;
  offset?: number;
  /** Set false to skip the total-count pass when only the top hits are shown. */
  count?: boolean;
  /** One row per source document instead of one per matching chunk. */
  distinct?: boolean;
};

function csvParam(values: readonly string[] | undefined): string | null {
  if (!values) return null;
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return cleaned.length > 0 ? cleaned.join(",") : null;
}

export function cloudSearchPath(params: CloudSearchParams): string {
  return queryPath("/cloud/search", {
    q: params.query.trim(),
    tickers: csvParam(params.tickers?.map(normalizeSymbol)),
    docTypes: csvParam(params.docTypes),
    sources: csvParam(params.sources),
    from: params.from || undefined,
    to: params.to || undefined,
    sort: params.sort || undefined,
    limit: params.limit,
    // Offset 0 is the default page, so sending it only lengthens the cache key.
    offset: params.offset || undefined,
    // Counting is the server default, so only opting out is worth a parameter.
    count: params.count === false ? "false" : undefined,
    distinct: params.distinct ? "true" : undefined,
  });
}

export function cloudSearchDocumentPath(docType: CloudSearchDocType, sourceId: string): string {
  return `/cloud/search/documents/${encodeURIComponent(docType)}/${encodeURIComponent(sourceId)}`;
}

export function cloudSavedSearchesPath(): string {
  return "/cloud/search/saved";
}

export function cloudSavedSearchPath(id: string): string {
  return `/cloud/search/saved/${encodeURIComponent(id)}`;
}

const joinCsv = (values: readonly string[] | undefined) => (values?.length ? values.join(",") : undefined);

export function cloudNewsPath(params: CloudNewsParams = {}): string {
  return queryPath("/news", {
    feed: params.feed || undefined,
    tickers: params.ticker ? (params.exchange ? publicTickerKey(params.ticker, params.exchange) : normalizeSymbol(params.ticker)) : undefined,
    tickerTier: params.tickerTier || undefined,
    tickerRelations: joinCsv(params.tickerRelations),
    limit: params.limit,
    topics: joinCsv(params.topics),
    categories: joinCsv(params.categories),
    sectors: joinCsv(params.sectors),
    sources: joinCsv(params.sources),
    excludeSources: joinCsv(params.excludeSources),
    sentiment: params.sentiment || undefined,
    minImportance: params.minImportance,
    minUrgency: params.minUrgency,
    breaking: params.breaking,
    since: params.since?.toISOString(),
    until: params.until?.toISOString(),
    cursor: params.cursor || undefined,
  });
}

/** Stories whose headline, summary or publisher matches the text, best match first; the service takes at most 100. */
/** `topics` are NI codes the stories must carry: `query=gold&topics=metals` is gold's market news. */
/**
 * `closest`: when no story has every word, the stories with the most of them, marked `match: "closest"`.
 * `tickers`: only the stories filed under them (`HAWK:NYSE`).
 */
export function cloudNewsSearchPath(
  query: string, limit?: number, topics?: readonly string[], options: { closest?: boolean; tickers?: readonly string[] } = {},
): string {
  return queryPath("/news/search", {
    query,
    limit,
    topics: joinCsv(topics),
    tickers: joinCsv(options.tickers),
    closest: options.closest ? "1" : undefined,
  });
}

export function cloudTickerTweetsPath(params: CloudTickerTweetsParams): string {
  return queryPath("/news/tweets", {
    ticker: params.ticker,
    limit: params.limit,
    offset: params.offset || undefined,
    hours: params.hours,
    includeReplies: params.includeReplies,
  });
}

export function cloudTweetSearchPath(params: CloudTweetSearchParams): string {
  return queryPath("/news/tweets/search", {
    query: params.query,
    queryType: params.queryType || undefined,
    limit: params.limit,
    offset: params.offset || undefined,
    hours: params.hours,
  });
}
