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

export interface CloudYieldPointPayload {
  maturity: string;
  maturityYears: number;
  yield: number | null;
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
  trades: CloudCongressTradePayload[];
  members: CloudCongressMemberPayload[];
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

export interface ScannerHiloPayload {
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

export interface ScannerFlowPayload {
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
