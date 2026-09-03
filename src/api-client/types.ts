import type {
  AnalystResearchData,
  CompanyProfile,
  CorporateActionsData,
  Fundamentals,
  HolderData,
  HolderRecord,
  OptionsChain,
  Quote,
} from "../types/financials";
import type { SyncSettings, SyncSnapshot } from "../sync/types";

export interface ChatUserSummary {
  id: string;
  username: string | null;
  displayName: string;
  bio?: string | null;
  company?: string | null;
  title?: string | null;
  profilePublic?: boolean;
  acceptUnknownDms?: boolean;
  portfolioAnalytics?: PublicPortfolioAnalytics | null;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  replyToId: string | null;
  createdAt: string;
  editedAt?: string | null;
  user: ChatUserSummary;
  replyTo?: { content: string; user: { id?: string; username: string } } | null;
  clientStatus?: "sending" | "failed";
  clientError?: string | null;
}

export interface ChatChannel {
  id: string;
  name: string;
  kind?: "public" | "direct" | "group";
  created_at: string;
  dmUser?: ChatUserSummary | null;
  members?: ChatUserSummary[];
}

export interface ChatChannelState {
  channelId: string;
  notificationsEnabled: boolean;
  lastReadMessageId: string | null;
  unreadCount: number;
}

export interface ChatNotification {
  id: string;
  type: "reply" | "mention" | "channel";
  channelId: string;
  messageId: string;
  createdAt: string;
  message: ChatMessage;
}

export interface ChatStateResponse {
  channels: ChatChannel[];
  onlineCount: number;
  channelStates: ChatChannelState[];
  notifications: ChatNotification[];
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  image: string | null;
  plan?: "free" | "pro";
  /** ISO timestamp when the free Pro trial ends; null once it has lapsed or was never started. */
  trialEndsAt?: string | null;
  /** Plan the server actually entitles right now, i.e. `plan` upgraded to "pro" while a trial is running. */
  effectivePlan?: "free" | "pro";
  company?: string | null;
  title?: string | null;
  bio?: string | null;
  profilePublic?: boolean;
  publicEmail?: string | null;
  xAccount?: string | null;
  sharedPortfolioId?: string | null;
  acceptUnknownDms?: boolean;
  chatEmailNotificationsEnabled?: boolean;
  portfolioAnalytics?: PublicPortfolioAnalytics | null;
  syncEnabled?: boolean;
  weeklyRoundupEnabled?: boolean;
  positionAlertsEnabled?: boolean;
  lastSyncAt?: string | null;
  lastRoundupEmailAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PersistedAuthUser = Pick<AuthUser, "id" | "emailVerified"> & Partial<AuthUser>;

export interface AccountProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  plan: "free" | "pro";
  /** ISO timestamp when the free Pro trial ends; null once it has lapsed or was never started. */
  trialEndsAt?: string | null;
  /** Plan the server actually entitles right now, i.e. `plan` upgraded to "pro" while a trial is running. */
  effectivePlan?: "free" | "pro";
  username: string | null;
  name: string;
  company: string | null;
  title: string | null;
  bio: string | null;
  profilePublic: boolean;
  publicEmail: string | null;
  xAccount: string | null;
  sharedPortfolioId: string | null;
  acceptUnknownDms: boolean;
  chatEmailNotificationsEnabled: boolean;
  portfolioAnalytics?: PublicPortfolioAnalytics | null;
  syncEnabled: boolean;
  weeklyRoundupEnabled: boolean;
  positionAlertsEnabled: boolean;
  lastSyncAt: string | null;
  lastRoundupEmailAt: string | null;
  updatedAt: string | null;
}

export interface PublicPortfolioAnalytics {
  oneYearReturn?: number | null;
  spyBeta?: number | null;
}

export interface BuildoutAccountResponse {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
  };
  subscription: {
    product: "buildout";
    plan: "free" | "pro";
    active: boolean;
    billingInterval: "month" | "year" | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionStatus: string | null;
  };
  prices: {
    monthly: {
      priceId: string;
      amountUsd: number;
      interval: "month";
    };
    yearly: {
      priceId: string;
      amountUsd: number;
      interval: "year";
    };
  };
}

export interface BuildoutTokenResponse {
  token: string;
  expiresAt: string;
}

export interface CloudPricingTier {
  /** Charged amount, in integer cents. */
  amount: number;
  /** List price the charged amount is discounted from, in integer cents. */
  anchorAmount: number;
}

/** Public `/pricing` payload; no session required. */
export interface CloudPricing {
  currency: "usd";
  trialDays: number;
  /** When false the anchor amount is the price, so it is shown without a strikethrough. */
  founding: boolean;
  monthly: CloudPricingTier;
  yearly: CloudPricingTier;
}

/** One command-bar prefix described for `/assist/command`. */
export interface AssistCommandDescriptor {
  prefix: string;
  name: string;
  description?: string;
  arg?: {
    placeholder?: string;
    kind: "text" | "ticker" | "ticker-list";
  };
}

/** A command-bar line the assistant believes answers the query. */
export interface AssistCommandCandidate {
  /** Exact command-bar text to run, e.g. "G NVDA AMD". */
  input: string;
  title: string;
  prefix: string;
  confidence: number;
}

export interface AssistCommandResponse {
  candidates: AssistCommandCandidate[];
}

export type AccountProfileUpdate = Partial<{
  username: string;
  name: string;
  company: string | null;
  title: string | null;
  bio: string | null;
  profilePublic: boolean;
  publicEmail: string | null;
  xAccount: string | null;
  sharedPortfolioId: string | null;
  acceptUnknownDms: boolean;
  chatEmailNotificationsEnabled: boolean;
  portfolioAnalytics: PublicPortfolioAnalytics | null;
  syncEnabled: boolean;
  weeklyRoundupEnabled: boolean;
  positionAlertsEnabled: boolean;
}>;

export interface CloudSyncSnapshotResponse {
  snapshot: SyncSnapshot | null;
  revision: number | null;
  updatedAt: string | null;
  settings: SyncSettings;
}

export interface CloudSyncPushResponse {
  revision: number;
  updatedAt: string;
  settings: SyncSettings;
}

export interface CloudRoundupPreviewResponse {
  subject: string;
  text: string;
  html: string;
  sender: string;
  replyTo: string;
  recipient: string;
}

export interface CloudQuotePayload extends Quote {
  providerId: "gloomberb-cloud";
  dataSource: "live" | "delayed";
}

export interface CloudWorldVenuePayload {
  mic: string;
  name: string;
  title: string;
  country: string;
  countryCode: string;
  city: string;
  timezone: string;
  latitude: number;
  longitude: number;
  isOpen: boolean;
  timeAfterOpenSeconds?: number;
  timeToOpenSeconds?: number;
  timeToCloseSeconds?: number;
}

export interface CloudWorldVenueMapPayload {
  providerId: "gloomberb-cloud";
  checkedAt: number;
  refreshAt: number;
  stale?: boolean;
  venues: CloudWorldVenuePayload[];
}

export interface CloudOptionsChainPayload extends OptionsChain {
  providerId: "gloomberb-cloud";
}

export interface CloudCompanyProfile extends CompanyProfile {}

export interface CloudFundamentals extends Fundamentals {}

interface CloudHolderPayload extends HolderRecord {
  providerId: "gloomberb-cloud";
  ownerType: "institution";
}

export interface CloudHoldersPayload extends HolderData {
  providerId: "gloomberb-cloud";
  holders: CloudHolderPayload[];
}

export interface CloudAnalystResearchPayload extends AnalystResearchData {
  providerId: "gloomberb-cloud";
}

export interface CloudCorporateActionsPayload extends CorporateActionsData {
  providerId: "gloomberb-cloud";
}

export interface CloudPricePointPayload {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

type CloudEconImpact = "high" | "medium" | "low";

export interface CloudEconEventPayload {
  id: string;
  date: string;
  time: string;
  country: string;
  event: string;
  actual: string | null;
  forecast: string | null;
  prior: string | null;
  impact: CloudEconImpact;
}

export interface CloudFredObservationPayload {
  date: string;
  value: number | null;
}

export interface CloudFredSeriesInfoPayload {
  id: string;
  title: string;
  units: string;
  frequency: string;
  seasonalAdjustment: string;
  source: string;
  notes: string;
}

export interface CloudFredSeriesPayload {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
}

/**
 * One month of Robert Shiller's dataset. FRED carries no long-run S&P earnings,
 * so this is what every earnings-based valuation ratio is built from.
 */
export interface CloudShillerObservationPayload {
  date: string;
  price: number | null;
  dividend: number | null;
  earnings: number | null;
  cpi: number | null;
  longRate: number | null;
  cape: number | null;
  /** CAPE earnings yield over the real 10-year rate; Shiller's equity risk premium. */
  excessCapeYield: number | null;
}

export interface CloudShillerPayload {
  observations: CloudShillerObservationPayload[];
  sourceUrl: string;
  fetchedAt: string;
}

/** One publicly disseminated single-name CDS transaction report. */
export interface CloudCdsTradePayload {
  disseminationId: string;
  originalDisseminationId: string | null;
  actionType: string;
  eventTimestamp: string;
  executionTimestamp: string | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  maturityDate: string | null;
  issuerName: string | null;
  underlierId: string | null;
  underlierIdSource: string | null;
  upi: string | null;
  upiFisn: string | null;
  upiUnderlierName: string | null;
  notionalAmount: number | null;
  /** Reported notional is a regulatory cap, so the real trade was at least this size. */
  notionalCapped: boolean;
  notionalCurrency: string | null;
  fixedRate: number | null;
  reportedSpread: number | null;
  /** Unit of `reportedSpread`, e.g. basis points or percent. */
  spreadNotation: string | null;
  upfrontAmount: number | null;
  upfrontCurrency: string | null;
}

export interface CloudCdsResponse {
  source: string;
  asOf: string | null;
  trades: CloudCdsTradePayload[];
}

export interface CloudShortInterestPointPayload {
  settlementDate: string;
  sharesShort: number;
  previousSharesShort: number | null;
  averageDailyVolume: number | null;
  daysToCover: number | null;
  changePercent: number | null;
  revised: boolean;
}

export interface CloudShortInterestPayload {
  symbol: string;
  issueName: string | null;
  points: CloudShortInterestPointPayload[];
}

export interface CloudYieldPointPayload {
  maturity: string;
  maturityYears: number;
  yield: number | null;
  /** FRED observation date. Absent on servers older than the field. */
  asOf?: string | null;
}

type CloudCongressTradeSide = "BUY" | "SELL" | "EXCHANGE" | "OTHER";

export interface CloudCongressTradePayload {
  id: string;
  chamber: "house";
  filingId: string;
  docId: string;
  memberName: string;
  stateDistrict: string;
  filingDate: string;
  transactionDate: string | null;
  notificationDate: string | null;
  lagDays: number | null;
  side: CloudCongressTradeSide;
  transactionType: string;
  ticker: string | null;
  assetName: string;
  assetType: string | null;
  owner: string;
  rawOwner: string;
  amount: string;
  amountLow: number | null;
  amountHigh: number | null;
  capGainsOver200: boolean | null;
  filingStatus: string | null;
  subholdingOf: string | null;
  description: string | null;
  sourceUrl: string;
}

export interface CloudCongressMemberPayload {
  id: string;
  memberName: string;
  stateDistrict: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  exchangeCount: number;
  otherCount: number;
  estimatedLow: number | null;
  estimatedHigh: number | null;
  lastFilingDate: string | null;
  avgLagDays: number | null;
}

export interface CloudCongressHousePayload {
  asOf: string;
  chamber: "house";
  source: "house-clerk";
  year: number;
  indexUpdatedAt: string | null;
  filingsScanned: number;
  filingCount: number;
  filingOffset?: number;
  hasMore?: boolean;
  hasMoreFilings?: boolean;
  nextOffset?: number;
  nextFilingOffset?: number;
  trades: CloudCongressTradePayload[];
  members: CloudCongressMemberPayload[];
}

export interface CloudEarningsCallPayload {
  id: string;
  ticker: string;
  companyName: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  callAt: string | null;
  status: string;
  durationSeconds: number | null;
  wordCount: number | null;
  hasTranscript: boolean;
  sentiment: number | null;
  /** The replay or event page the transcript came from. */
  webcastUrl?: string | null;
}

export interface CloudEarningsCallListPayload {
  calls: CloudEarningsCallPayload[];
  /** Set when asking about a company started a search that is still running. */
  pending?: boolean;
  /** Set when the requested symbol is not one the SEC knows. */
  unknownTicker?: boolean;
}

export interface CloudTranscriptTurnPayload {
  speaker: string;
  role?: string;
  company?: string;
  text: string;
  isQa: boolean;
  startSeconds: number;
}

export interface CloudTranscriptParticipantPayload {
  name: string;
  role?: string;
  company?: string;
}

export interface CloudEarningsTranscriptPayload {
  id: string;
  ticker: string;
  companyName: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  callAt: string | null;
  timing: string | null;
  webcastUrl: string | null;
  durationSeconds: number | null;
  status: string;
  fullText: string;
  turns: CloudTranscriptTurnPayload[];
  participants: CloudTranscriptParticipantPayload[];
  summary: string | null;
  guidance: string | null;
  riskFactors: string | null;
  analystFocus: string | null;
  notable: string | null;
  sentiment: number | null;
  sentimentRationale: string | null;
  qaStartTurn: number | null;
  wordCount: number | null;
  asrModel: string | null;
  updatedAt: string | null;
}

export type CloudSearchDocType = "transcript" | "news" | "filing";

export type CloudSearchSort = "relevance" | "newest" | "oldest";

/**
 * Per-chunk provenance. Which keys are present depends on `docType`: transcripts
 * carry speaker attribution, news carries the wire source, filings carry the
 * form and section. Kept as one optional-key record so an unknown docType from a
 * newer server still renders instead of failing to parse.
 */
export interface CloudSearchChunkMetadata {
  speaker?: string;
  role?: string;
  company?: string;
  isQa?: boolean;
  startSeconds?: number;
  turnIndex?: number;
  source?: string;
  summary?: string;
  form?: string;
  accession?: string;
  section?: string;
}

export interface CloudSearchHit {
  id: string;
  docType: CloudSearchDocType;
  sourceId: string;
  chunkIndex: number;
  ticker: string;
  publishedAt: string;
  title: string;
  url: string;
  /** Matched terms wrapped in `<mark>`, fragments joined by an ellipsis. */
  snippet: string;
  score: number;
  metadata: CloudSearchChunkMetadata;
  /**
   * Chunks of this document that matched. Only sent for a distinct search,
   * where the row stands for the document rather than for one chunk.
   */
  matchCount?: number;
}

export interface CloudSearchResponse {
  hits: CloudSearchHit[];
  total: number;
  /** The server stopped counting past its cap, so `total` is a lower bound. */
  countCapped: boolean;
  hasMore: boolean;
  nextOffset: number;
  tookMs: number;
}

export interface CloudSearchDocumentChunk {
  id: string;
  chunkIndex: number;
  body: string;
  metadata: CloudSearchChunkMetadata;
}

export interface CloudSearchDocument {
  docType: CloudSearchDocType;
  sourceId: string;
  ticker: string;
  title: string;
  url: string;
  publishedAt: string;
  chunks: CloudSearchDocumentChunk[];
}

export interface CloudSearchDocumentResponse {
  document: CloudSearchDocument;
}

export interface CloudSavedSearchFilters {
  tickers?: string[];
  docTypes?: CloudSearchDocType[];
  sources?: string[];
  from?: string;
  to?: string;
}

export interface CloudSavedSearch {
  id: string;
  name: string;
  query: string;
  filters: CloudSavedSearchFilters;
  alertEnabled: boolean;
  alertChannels: string[];
  lastRunAt: string | null;
  lastMatchAt: string | null;
  matchCount: number;
  createdAt: string;
}

export interface CloudSavedSearchListResponse {
  searches: CloudSavedSearch[];
}

export interface CloudSavedSearchInput {
  name: string;
  query: string;
  filters?: CloudSavedSearchFilters;
  alertEnabled?: boolean;
  alertChannels?: string[];
}

export interface CloudSecFilingPayload {
  accessionNumber: string;
  form: string;
  filingDate: string;
  acceptedAt?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  items?: string;
  cik: string;
  companyName?: string;
  filingUrl: string;
  primaryDocumentUrl?: string;
}

export interface CloudSecDocumentPayload {
  sequence?: string;
  type: string;
  description?: string;
  document: string;
  url: string;
  size?: string;
  isPrimary: boolean;
}

export interface CloudSecFilingsResponse {
  filings: CloudSecFilingPayload[];
  hasMore: boolean;
  nextOffset: number;
}

export interface CloudSecDocumentsResponse {
  documents: CloudSecDocumentPayload[];
}

export interface CloudSecForm4Payload {
  filingDate: string;
  reportedName: string;
  title: string;
  transactionType: "P" | "S" | "A" | "D" | "";
  shares: number;
  pricePerShare: number | null;
  totalValue: number | null;
  sharesOwned: number | null;
  form: string;
}

export interface CloudSecContentResponse {
  content: string | null;
  form4: CloudSecForm4Payload | null;
}

interface CloudNewsEntityPayload {
  id: string;
  entityType: string;
  name: string;
  symbol: string | null;
  exchange: string | null;
  canonicalTicker: string | null;
  role: string | null;
  confidence: number | null;
}

interface CloudNewsTickerLinkPayload {
  symbol: string;
  exchange: string;
  canonicalTicker: string;
  relationType: string;
  displayTier: "primary" | "related";
  confidence: number;
  relevanceScore: number;
  impactScore?: number;
  sentiment?: "positive" | "neutral" | "negative" | null;
}

export interface CloudNewsStoryItemPayload {
  id: string;
  sourceKey: string;
  sourceName: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt: string;
  hasArticleText?: boolean;
}

export interface CloudNewsPayload {
  id: string;
  headline: string;
  summary: string;
  topic?: string;
  topics?: string[];
  category: string;
  sentiment: "positive" | "neutral" | "negative";
  sectors: string[];
  scope?: string;
  firstPublishedAt: string;
  lastPublishedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  primaryUrl: string;
  primarySource: string;
  scores?: {
    importance?: number;
    urgency?: number;
    marketImpact?: number;
    novelty?: number;
    confidence?: number;
  };
  flags?: {
    breaking?: boolean;
    developing?: boolean;
    stale?: boolean;
  };
  variantCount: number;
  sourceCount: number;
  sources: string[];
  entities: CloudNewsEntityPayload[];
  tickerLinks: CloudNewsTickerLinkPayload[];
  items?: CloudNewsStoryItemPayload[];
}

export interface CloudNewsListResponse {
  items: CloudNewsPayload[];
  nextCursor: string | null;
}

interface CloudTweetUserPayload {
  id: string;
  userName: string;
  name: string;
}

interface CloudTweetMetricsPayload {
  retweets: number | null;
  replies: number | null;
  likes: number | null;
  quotes: number | null;
  views: number | null;
  bookmarks: number | null;
}

interface CloudTweetMediaPayload {
  type?: string;
  url?: string;
  mediaUrl?: string;
  media_url?: string;
  media_url_https?: string;
  previewImageUrl?: string;
  preview_image_url?: string;
}

export interface CloudTweetPayload {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  lang: string;
  isReply: boolean;
  author: CloudTweetUserPayload;
  metrics: CloudTweetMetricsPayload;
  media?: CloudTweetMediaPayload[];
  photos?: CloudTweetMediaPayload[];
  images?: CloudTweetMediaPayload[];
}

export type CloudTweetQueryType = "Latest" | "Top";

export interface CloudTweetSearchResponse {
  ticker?: string;
  cashtag?: string;
  query: string;
  queryType: CloudTweetQueryType;
  since: string;
  until: string;
  limit: number;
  hours: number;
  includeReplies?: boolean;
  cached: boolean;
  cacheTtlMs: number;
  asOf: string;
  tweets: CloudTweetPayload[];
}

type CloudMarketStatus =
  | "success"
  | "partial"
  | "empty"
  | "unsupported"
  | "retryable_error"
  | "fatal_error";

export interface CloudMarketResponse<T> {
  status: CloudMarketStatus;
  data: T | null;
  reasonCode?: string;
  asOf?: string;
  staleAt?: string;
  stale?: boolean;
  currency?: string;
  providerMeta?: {
    provider?: string;
    upstream?: string;
    status?: CloudMarketStatus;
    reasonCode?: string;
    normalizedSymbol?: string;
    normalizedExchange?: string;
    stale?: boolean;
    fallbackReason?: string;
    requestedResolution?: string;
    servedResolution?: string;
    latencyMs?: number;
    range?: string;
    granularity?: string;
    timezone?: string;
    currency?: string;
    barCount?: number;
  };
}

export interface CloudMarketBatchTarget {
  symbol: string;
  exchange?: string;
}

export interface CloudMarketBatchItem<T> {
  symbol: string;
  exchange: string;
  status: CloudMarketStatus;
  data: T | null;
  reasonCode?: string;
}

export interface CloudMarketBatchPayload<T> {
  items: Array<CloudMarketBatchItem<T>>;
}

export type CloudMarketScreenerCategory = "gainers" | "losers" | "most-active";

export interface CloudMarketScreenerItem {
  rank: number;
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  tradeCount?: number;
  currency: string;
  high52w?: number;
  low52w?: number;
  dayHigh?: number;
  dayLow?: number;
  exchange: string;
  lastUpdated: number;
  dataSource: "live";
}

export interface CloudMarketScreenerPayload {
  providerId: "gloomberb-cloud";
  category: CloudMarketScreenerCategory;
  asOf: string;
  stale?: boolean;
  items: CloudMarketScreenerItem[];
}

/** Cache reuse policy for one Equity Diagnostic request. */
export type CloudEquityDiagnosticMode = "cache-first" | "refresh";

export type CloudEquityDiagnosticFindingKind = "red_flag" | "green_flag" | "anomaly";

/** 3 is the most severe. */
export type CloudEquityDiagnosticSeverity = 1 | 2 | 3;

export interface CloudEquityDiagnosticFinding {
  id: string;
  kind: CloudEquityDiagnosticFindingKind;
  severity: CloudEquityDiagnosticSeverity;
  confidence: number;
  title: string;
  /** What the data says, with no reading attached. */
  observation: string;
  /** What the observation may mean; kept apart from the observation on purpose. */
  interpretation: string;
  /** Ids into `evidence`; unresolved ids are dropped by the client. */
  evidenceIds: string[];
}

export interface CloudEquityDiagnosticCoverage {
  dataset: string;
  status: "available" | "no_data" | "unsupported" | "failed";
  asOf?: string;
  provider?: string;
  note?: string;
}

/** The server owns citation URLs; the client never builds them. */
export interface CloudEquityDiagnosticEvidence {
  id: string;
  dataset: string;
  label: string;
  asOf?: string;
  provider?: string;
  url?: string;
}

export interface CloudEquityDiagnosticPending {
  status: "generating";
  retryAfterMs: number;
}

export interface CloudEquityDiagnosticResponse {
  schemaVersion: 1;
  access: "preview" | "full";
  symbol: string;
  exchange: string;
  companyName?: string;
  status: "complete" | "partial" | "insufficient_data";
  verdict: "risk_skewed" | "balanced" | "opportunity_skewed" | "unclear";
  summary: string;
  confidence: number;
  findings: CloudEquityDiagnosticFinding[];
  watchItems: string[];
  coverage: CloudEquityDiagnosticCoverage[];
  evidence: CloudEquityDiagnosticEvidence[];
  generatedAt: string;
  expiresAt: string;
  /** Before this instant a `refresh` request may still answer from cache. */
  refreshAllowedAt: string;
  cached: boolean;
  stale: boolean;
  promptVersion: 1;
  model: "gpt-5.6-luna";
}

export type CloudEquityDiagnosticResult =
  | CloudEquityDiagnosticPending
  | CloudEquityDiagnosticResponse;

export interface CloudVerificationResponse {
  sent: boolean;
  email?: string;
  alreadyVerified?: boolean;
}

/** A short-lived, single-use browser URL that establishes the existing desktop session. */
export interface CloudBrowserHandoffResponse {
  url: string;
}

export interface DeviceAuthStartResponse {
  deviceCode: string;
  /** 8 characters formatted "XXXX-XXXX", shown so a user without the app can type it. */
  userCode: string;
  expiresAt: string;
  /** Like https://gloom.sh/link/<userCode>; this is what the QR code encodes. */
  verificationUri: string;
  pollIntervalMs: number;
}

/** The approved response is single-use; polling again returns a non-approved status. */
export type DeviceAuthTokenResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; sessionToken: string; user: AuthUser };

/** Shared server-computed scanners fanned out to every subscriber. */
export type ScannerKind = "hilo" | "flow";

export type ScannerStatus = "live" | "starting" | "closed" | "degraded";

export interface ScannerWindowCounts {
  highs: number;
  lows: number;
}

export interface ScannerHiloExtreme {
  symbol: string;
  price: number;
  volume?: number | null;
  /** Times this symbol printed a new session extreme today. */
  count: number;
  at: number;
}

/** Which entitlement tier produced the payload: free accounts get a delayed instance. */
export interface ScannerAccessInfo {
  access: "realtime" | "delayed";
  /** 0 on the realtime instance, 15 on the delayed one. */
  delayMinutes: number;
}

export interface ScannerHiloPayload extends ScannerAccessInfo {
  status: ScannerStatus;
  asOf: number;
  windows: {
    s30: ScannerWindowCounts;
    m1: ScannerWindowCounts;
    m5: ScannerWindowCounts;
  };
  highs: ScannerHiloExtreme[];
  lows: ScannerHiloExtreme[];
}

export interface ScannerFlowEvent {
  id: string;
  at: number;
  underlying: string;
  contract: string;
  right: "C" | "P";
  strike: number;
  expiry: string;
  side: "ask" | "bid" | "mid" | "unknown";
  kind: "sweep" | "block" | "split" | "trade";
  size: number;
  price: number;
  premium: number;
  volume?: number | null;
  openInterest?: number | null;
  volOi?: number | null;
  iv?: number | null;
}

export interface ScannerFlowPayload extends ScannerAccessInfo {
  status: ScannerStatus;
  asOf: number;
  events: ScannerFlowEvent[];
}

export type ScannerPayload = ScannerHiloPayload | ScannerFlowPayload;

/** What a scanner subscriber receives: data, or the entitlement refusal. */
export type ScannerFeedEvent<T extends ScannerPayload = ScannerPayload> =
  | { type: "data"; payload: T }
  | { type: "denied"; reason: string };

export interface QuoteStreamTarget {
  symbol: string;
  exchange?: string;
  surface?: "portfolio" | "watchlist" | "detail" | "monitor" | "inline" | "options" | "screener" | "unknown";
  visible?: boolean;
  selected?: boolean;
  weight?: number;
}
