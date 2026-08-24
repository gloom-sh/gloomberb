import type { TickerFinancials } from "../types/financials";
import type { InstrumentSearchResult } from "../types/instrument";
import { CloudAuthApi } from "./auth";
import { CloudChatApi } from "./chat";
import { CloudDataApi } from "./data";
import { CloudApiRequestTransport } from "./request";
import { CloudApiSocket } from "./socket";
import type {
  CloudCongressHouseParams,
  CloudFredSeriesParams,
  CloudSecFilingParams,
  CloudSecFilingsParams,
  CloudHistoryParams,
  CloudNewsParams,
  CloudTickerTweetsParams,
  CloudTweetSearchParams,
} from "./paths";
import { withDeadline } from "../utils/async-deadline";
import type {
  AssistCommandDescriptor,
  AssistCommandResponse,
  ChatMessage,
  ChatChannel,
  ChatChannelState,
  ChatNotification,
  ChatStateResponse,
  AuthUser,
  PersistedAuthUser,
  AccountProfile,
  BuildoutAccountResponse,
  BuildoutTokenResponse,
  CloudPricing,
  AccountProfileUpdate,
  CloudQuotePayload,
  CloudOptionsChainPayload,
  CloudCompanyProfile,
  CloudFundamentals,
  CloudHoldersPayload,
  CloudAnalystResearchPayload,
  CloudShortInterestPayload,
  CloudBrowserHandoffResponse,
  CloudCorporateActionsPayload,
  CloudPricePointPayload,
  CloudEconEventPayload,
  CloudEquityDiagnosticMode,
  CloudEquityDiagnosticResponse,
  CloudFredSeriesPayload,
  CloudYieldPointPayload,
  CloudCongressHousePayload,
  CloudNewsPayload,
  CloudSecContentResponse,
  CloudSecDocumentsResponse,
  CloudSecFilingsResponse,
  CloudNewsListResponse,
  CloudTweetSearchResponse,
  CloudMarketResponse,
  CloudMarketBatchTarget,
  CloudMarketBatchPayload,
  CloudMarketScreenerCategory,
  CloudMarketScreenerPayload,
  CloudVerificationResponse,
  DeviceAuthStartResponse,
  DeviceAuthTokenResponse,
  CloudRoundupPreviewResponse,
  CloudSyncPushResponse,
  CloudSyncSnapshotResponse,
  QuoteStreamTarget,
  ScannerFeedEvent,
  ScannerKind,
} from "./types";
import type { SyncSettings, SyncSnapshot } from "../sync/types";

export type * from "./types";
export { setCloudApiFetchTransport } from "./request";

/** Server-side caps for `/assist/command`; enforced here so a 422 is never sent. */
const ASSIST_QUERY_MAX_LENGTH = 200;
const ASSIST_COMMAND_LIMIT = 150;
const ASSIST_REQUEST_TIMEOUT_MS = 6_000;

class GloomApiClient {
  private currentUser: AuthUser | null = null;
  private sessionChecked = false;
  private sessionRequest: Promise<AuthUser | null> | null = null;
  private readonly currentUserListeners = new Set<() => void>();
  private readonly transport = new CloudApiRequestTransport();
  private readonly auth: CloudAuthApi;
  private readonly socket: CloudApiSocket;
  private readonly chat: CloudChatApi;
  private readonly data: CloudDataApi;

  constructor() {
    this.auth = new CloudAuthApi({
      getCurrentUser: () => this.currentUser,
      getSessionToken: () => this.transport.getSessionToken(),
      hasSessionCredential: () => this.transport.hasSessionCredential(),
      request: (path, options) => this.request(path, options),
      requireCapturedSession: (message) => this.requireCapturedSession(message),
      setCurrentUser: (user) => this.setCurrentUser(user),
      setSessionToken: (token) => this.setSessionToken(token),
      updateCurrentUser: (updater) => this.updateCurrentUser(updater),
    });
    this.socket = new CloudApiSocket({
      getBaseUrl: () => this.transport.baseUrl,
      getSocketAuthToken: () => this.getSocketAuthToken(),
      hasSessionCredential: () => this.transport.hasSessionCredential(),
      hasVerifiedUser: () => this.currentUser?.emailVerified === true,
      isUsingWebSocketToken: () => !!this.transport.getWebSocketToken(),
      clearWebSocketTokenForFallback: () => this.transport.clearWebSocketTokenForFallback(),
      markCurrentUserUnverified: () => {
        if (this.currentUser) {
          this.currentUser = { ...this.currentUser, emailVerified: false };
        }
      },
      updateCurrentUserFromSocket: (user) => {
        this.updateCurrentUser((currentUser) => ({
          ...currentUser,
          ...user,
        }));
      },
    });
    this.chat = new CloudChatApi({
      request: (path, options) => this.request(path, options),
      socket: this.socket,
    });
    this.data = new CloudDataApi((path, options) => this.request(path, options));
  }

  getSessionToken(): string | null {
    return this.transport.getSessionToken();
  }

  getWebSocketToken(): string | null {
    return this.transport.getWebSocketToken();
  }

  setCookieSessionMode(enabled: boolean): void {
    this.sessionChecked = false;
    this.transport.setCookieSessionMode(enabled);
  }

  setSessionToken(token: string | null): void {
    const changed = this.transport.getSessionToken() !== token;
    this.sessionChecked = false;
    this.transport.setSessionToken(token);
    if (!token) {
      this.currentUser = null;
      this.emitCurrentUserChange();
    }
    this.socket.syncAuthState({ reconnect: changed });
  }

  setWebSocketToken(token: string | null): void {
    const changed = this.transport.getWebSocketToken() !== token;
    this.transport.setWebSocketToken(token);
    this.socket.syncAuthState({ reconnect: changed });
  }

  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  /**
   * Whether a signed-in session exists on this surface. Browser builds keep the
   * session in an HttpOnly cookie, so the raw token is deliberately null there
   * and the restored user is the only signal.
   */
  isSignedIn(): boolean {
    return !!this.transport.getSessionToken() || !!this.currentUser;
  }

  /** Notifies when the signed-in user changes, including plan and trial entitlement. */
  subscribeCurrentUser(listener: () => void): () => void {
    this.currentUserListeners.add(listener);
    return () => {
      this.currentUserListeners.delete(listener);
    };
  }

  restoreCachedUser(user: PersistedAuthUser | null): void {
    this.auth.restoreCachedUser(user);
  }

  isVerified(): boolean {
    return this.transport.hasSessionCredential() && !!this.currentUser?.emailVerified;
  }

  private setCurrentUser(user: AuthUser | null): void {
    const changed = this.socketEntitlementKey(this.currentUser) !== this.socketEntitlementKey(user);
    this.currentUser = user;
    this.socket.syncAuthState({ reconnect: changed });
    this.emitCurrentUserChange();
  }

  private emitCurrentUserChange(): void {
    for (const listener of this.currentUserListeners) listener();
  }

  private updateCurrentUser(updater: (user: AuthUser) => AuthUser): void {
    if (!this.currentUser) return;
    this.setCurrentUser(updater(this.currentUser));
  }

  private socketEntitlementKey(user: AuthUser | null): string {
    if (!user) return "anonymous";
    return [
      user.id,
      user.emailVerified === true ? "verified" : "unverified",
      user.plan,
      // A trial starting or lapsing changes the stream entitlement without touching `plan`.
      user.effectivePlan,
    ].join(":");
  }

  private requireCapturedSession(message: string): void {
    if (this.transport.hasSessionCredential()) return;
    this.transport.setWebSocketToken(null);
    this.setCurrentUser(null);
    throw new Error(message);
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    return this.transport.request<T>(path, options);
  }

  private getSocketAuthToken(): string | null {
    return this.transport.getSocketAuthToken();
  }

  async ensureVerifiedSession(): Promise<AuthUser | null> {
    if (!this.transport.hasSessionCredential()) return null;
    if (!this.currentUser && !this.sessionChecked) await this.getSession();
    return this.currentUser?.emailVerified ? this.currentUser : null;
  }

  async signUp(email: string, username: string, name: string, password: string): Promise<AuthUser> {
    return this.auth.signUp(email, username, name, password);
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    return this.auth.signIn(email, password);
  }

  async startDeviceSignIn(body: { clientName?: string; clientPlatform?: string }): Promise<DeviceAuthStartResponse> {
    return this.auth.startDeviceSignIn(body);
  }

  async pollDeviceSignIn(deviceCode: string): Promise<DeviceAuthTokenResponse> {
    return this.auth.pollDeviceSignIn(deviceCode);
  }

  async signOut(): Promise<void> {
    return this.auth.signOut();
  }

  async getSession(): Promise<AuthUser | null> {
    if (this.sessionRequest) return this.sessionRequest;
    this.sessionRequest = this.auth.getSession();
    try {
      const user = await this.sessionRequest;
      this.sessionChecked = true;
      return user;
    } finally {
      this.sessionRequest = null;
    }
  }

  async sendVerification(): Promise<CloudVerificationResponse> {
    return this.auth.sendVerification();
  }

  async requestPasswordReset(email: string): Promise<void> {
    return this.auth.requestPasswordReset(email);
  }

  async createBrowserHandoff(): Promise<CloudBrowserHandoffResponse> {
    return this.auth.createBrowserHandoff();
  }

  /** Creates a Stripe checkout session for Cloud Pro; the URL opens in a browser. */
  async createCloudCheckout(): Promise<{ url: string }> {
    return this.request<{ url: string }>("/stripe/checkout", { method: "POST", body: JSON.stringify({}) });
  }

  /** Stripe billing portal for an account that already has a subscription. */
  async createBillingPortal(): Promise<{ url: string }> {
    return this.request<{ url: string }>("/stripe/portal", { method: "POST", body: JSON.stringify({}) });
  }

  async getAccountProfile(): Promise<AccountProfile> {
    return this.auth.getAccountProfile();
  }

  async getCloudPricing(): Promise<CloudPricing> {
    return this.auth.getCloudPricing();
  }

  async getBuildoutAccount(): Promise<BuildoutAccountResponse> {
    return this.auth.getBuildoutAccount();
  }

  async getBuildoutToken(): Promise<BuildoutTokenResponse> {
    return this.auth.getBuildoutToken();
  }

  async updateAccountProfile(update: AccountProfileUpdate): Promise<AccountProfile> {
    return this.auth.updateAccountProfile(update);
  }

  async getSyncSnapshot(): Promise<CloudSyncSnapshotResponse> {
    return this.request<CloudSyncSnapshotResponse>("/sync/snapshot", { method: "GET" });
  }

  async putSyncSnapshot(snapshot: SyncSnapshot, options?: { baseRevision?: number | null }): Promise<CloudSyncPushResponse> {
    return this.request<CloudSyncPushResponse>("/sync/snapshot", {
      method: "PUT",
      body: JSON.stringify({
        snapshot,
        baseRevision: options?.baseRevision ?? null,
      }),
    });
  }

  async updateSyncSettings(update: Partial<SyncSettings>): Promise<SyncSettings> {
    const result = await this.request<{ settings: SyncSettings }>("/sync/settings", {
      method: "PATCH",
      body: JSON.stringify(update),
    });
    if (this.currentUser) {
      this.currentUser = {
        ...this.currentUser,
        syncEnabled: result.settings.syncEnabled,
        weeklyRoundupEnabled: result.settings.weeklyRoundupEnabled,
        positionAlertsEnabled: result.settings.positionAlertsEnabled,
        lastSyncAt: result.settings.lastSyncAt ?? this.currentUser.lastSyncAt,
        lastRoundupEmailAt: result.settings.lastRoundupEmailAt ?? this.currentUser.lastRoundupEmailAt,
      };
    }
    return result.settings;
  }

  async getRoundupPreview(): Promise<CloudRoundupPreviewResponse> {
    return this.request<CloudRoundupPreviewResponse>("/sync/roundup/preview", { method: "POST", body: JSON.stringify({}) });
  }

  async sendRoundupTestEmail(): Promise<CloudRoundupPreviewResponse> {
    return this.request<CloudRoundupPreviewResponse>("/sync/roundup/test-email", { method: "POST", body: JSON.stringify({}) });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.auth.changePassword(currentPassword, newPassword);
  }

  async deleteAccount(): Promise<void> {
    return this.auth.deleteAccount();
  }

  /**
   * Resolves a natural-language command-bar query into runnable command-bar
   * inputs. Requires a verified session; free accounts are included. The
   * request is bounded client-side so a stalled upstream cannot hold the
   * command bar in its loading state.
   */
  async assistCommand(
    query: string,
    commands: AssistCommandDescriptor[],
    options?: { signal?: AbortSignal },
  ): Promise<AssistCommandResponse> {
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      const request = this.request<AssistCommandResponse>("/assist/command", {
        method: "POST",
        body: JSON.stringify({
          query: query.trim().slice(0, ASSIST_QUERY_MAX_LENGTH),
          commands: commands.slice(0, ASSIST_COMMAND_LIMIT),
        }),
        signal: controller.signal,
      });
      return await withDeadline(
        request,
        ASSIST_REQUEST_TIMEOUT_MS,
        `Assist request timed out after ${ASSIST_REQUEST_TIMEOUT_MS}ms`,
        (error) => controller.abort(error),
      );
    } finally {
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async getChannels(): Promise<ChatChannel[]> {
    return this.chat.getChannels();
  }

  async getChatPresence(): Promise<{ onlineCount: number }> {
    return this.chat.getPresence();
  }

  async getChatState(): Promise<ChatStateResponse> {
    return this.chat.getState();
  }

  async updateChatChannelState(
    channelId: string,
    body: { notificationsEnabled?: boolean; readThroughMessageId?: string },
  ): Promise<ChatChannelState> {
    return this.chat.updateChannelState(channelId, body);
  }

  async markChatNotificationsDelivered(notificationIds: string[]): Promise<{ delivered: number }> {
    return this.chat.markNotificationsDelivered(notificationIds);
  }

  async openDirectChannel(target: { userId?: string; username?: string }): Promise<ChatChannel> {
    return this.chat.openDirectChannel(target);
  }

  async openGroupChannel(body: { userIds?: string[]; usernames?: string[]; name?: string }): Promise<ChatChannel> {
    return this.chat.openGroupChannel(body);
  }

  async getMessages(
    channelId: string,
    opts?: { after?: string; before?: string; limit?: number },
  ): Promise<ChatMessage[]> {
    return this.chat.getMessages(channelId, opts);
  }

  async sendMessage(channelId: string, content: string, replyToId?: string, clientMessageId?: string): Promise<ChatMessage> {
    return this.chat.sendMessage(channelId, content, replyToId, clientMessageId);
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<ChatMessage> {
    return this.chat.editMessage(channelId, messageId, content);
  }

  connectChannel(
    channelId: string,
    onMessage: (msg: ChatMessage) => void,
    onError?: (err: string) => void,
  ): { send: (content: string, replyToId?: string, clientMessageId?: string) => Promise<ChatMessage>; close: () => void } {
    return this.chat.connectChannel(channelId, onMessage, onError);
  }

  subscribeChatNotifications(listener: (notification: ChatNotification) => void): () => void {
    return this.chat.subscribeNotifications(listener);
  }

  subscribeChatPresence(listener: (onlineCount: number) => void): () => void {
    return this.chat.subscribePresence(listener);
  }

  subscribeQuotes(
    targets: QuoteStreamTarget[],
    onQuote: (target: QuoteStreamTarget, quote: CloudQuotePayload) => void,
  ): () => void {
    return this.socket.subscribeQuotes(targets, onQuote);
  }

  /** Subscribes to a shared scanner feed; all panes of one kind share one upstream subscription. */
  subscribeScanner(scanner: ScannerKind, listener: (event: ScannerFeedEvent) => void): () => void {
    return this.socket.subscribeScanner(scanner, listener);
  }

  dispose(): void {
    this.socket.dispose();
  }

  async searchInstruments(query: string, limit = 10): Promise<InstrumentSearchResult[]> {
    return this.data.searchInstruments(query, limit);
  }

  async getCloudQuote(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudQuotePayload>> {
    return this.data.getCloudQuote(symbol, exchange);
  }

  async getCloudQuotesBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<CloudQuotePayload>>> {
    return this.data.getCloudQuotesBatch(targets, mode);
  }

  async getCloudMarketScreener(
    category: CloudMarketScreenerCategory,
    count = 25,
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketScreenerPayload>> {
    return this.data.getCloudMarketScreener(category, count, mode);
  }

  async getCloudOptionsChain(
    symbol: string,
    exchange?: string,
    expirationDate?: number,
  ): Promise<CloudMarketResponse<CloudOptionsChainPayload>> {
    return this.data.getCloudOptionsChain(symbol, exchange, expirationDate);
  }

  async getCloudProfile(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudCompanyProfile>> {
    return this.data.getCloudProfile(symbol, exchange);
  }

  async getCloudFundamentals(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudFundamentals>> {
    return this.data.getCloudFundamentals(symbol, exchange);
  }

  async getCloudFinancials(symbol: string, exchange?: string): Promise<CloudMarketResponse<TickerFinancials>> {
    return this.data.getCloudFinancials(symbol, exchange);
  }

  async getCloudFinancialsBatch(
    targets: CloudMarketBatchTarget[],
    mode: "cache-first" | "refresh" = "cache-first",
  ): Promise<CloudMarketResponse<CloudMarketBatchPayload<TickerFinancials>>> {
    return this.data.getCloudFinancialsBatch(targets, mode);
  }

  async getCloudHolders(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudHoldersPayload>> {
    return this.data.getCloudHolders(symbol, exchange);
  }

  async getCloudShortInterest(symbol: string, years?: number): Promise<CloudMarketResponse<CloudShortInterestPayload>> {
    return this.data.getCloudShortInterest(symbol, years);
  }

  async getCloudAnalystResearch(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudAnalystResearchPayload>> {
    return this.data.getCloudAnalystResearch(symbol, exchange);
  }

  async getCloudCorporateActions(symbol: string, exchange?: string): Promise<CloudMarketResponse<CloudCorporateActionsPayload>> {
    return this.data.getCloudCorporateActions(symbol, exchange);
  }

  async getCloudStatements(
    symbol: string,
    exchange?: string,
    period: "annual" | "quarterly" | "both" = "both",
  ): Promise<CloudMarketResponse<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">>> {
    return this.data.getCloudStatements(symbol, exchange, period);
  }

  async getCloudHistory(
    symbol: string,
    exchange: string,
    params: CloudHistoryParams = {},
  ): Promise<CloudMarketResponse<CloudPricePointPayload[]>> {
    return this.data.getCloudHistory(symbol, exchange, params);
  }

  async getCloudExchangeRate(fromCurrency: string): Promise<CloudMarketResponse<{ rate: number }>> {
    return this.data.getCloudExchangeRate(fromCurrency);
  }

  async getCloudEconomicCalendar(): Promise<CloudEconEventPayload[]> {
    return this.data.getCloudEconomicCalendar();
  }

  async getCloudEquityDiagnostic(
    symbol: string,
    exchange?: string,
    mode: CloudEquityDiagnosticMode = "cache-first",
  ): Promise<CloudEquityDiagnosticResponse> {
    return this.data.getCloudEquityDiagnostic(symbol, exchange, mode);
  }

  async getCloudFredSeries(
    seriesId: string,
    params: CloudFredSeriesParams = {},
  ): Promise<CloudFredSeriesPayload> {
    return this.data.getCloudFredSeries(seriesId, params);
  }

  async getCloudYieldCurve(): Promise<CloudYieldPointPayload[]> {
    return this.data.getCloudYieldCurve();
  }

  async getCloudCongressHouse(params: CloudCongressHouseParams = {}): Promise<CloudCongressHousePayload> {
    return this.data.getCloudCongressHouse(params);
  }

  async getCloudSecFilings(params: CloudSecFilingsParams): Promise<CloudSecFilingsResponse> {
    return this.data.getCloudSecFilings(params);
  }

  async getCloudSecFilingDocuments(params: CloudSecFilingParams): Promise<CloudSecDocumentsResponse> {
    return this.data.getCloudSecFilingDocuments(params);
  }

  async getCloudSecFilingContent(params: CloudSecFilingParams): Promise<CloudSecContentResponse> {
    return this.data.getCloudSecFilingContent(params);
  }

  async getCloudSec13F(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    return this.data.getCloudSec13F(path, params);
  }

  async getCloudNews(params: CloudNewsParams = {}): Promise<CloudNewsListResponse> {
    return this.data.getCloudNews(params);
  }

  async getCloudNewsStory(storyId: string): Promise<CloudNewsPayload> {
    return this.data.getCloudNewsStory(storyId);
  }

  async getCloudTickerTweets(params: CloudTickerTweetsParams): Promise<CloudTweetSearchResponse> {
    return this.data.getCloudTickerTweets(params);
  }

  async searchCloudTweets(params: CloudTweetSearchParams): Promise<CloudTweetSearchResponse> {
    return this.data.searchCloudTweets(params);
  }
}

export const apiClient = new GloomApiClient();
