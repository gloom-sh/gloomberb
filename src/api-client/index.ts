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
  CloudHistoryParams,
  CloudNewsParams,
  CloudTickerTweetsParams,
  CloudTweetSearchParams,
} from "./paths";
import type {
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
  AccountProfileUpdate,
  CloudQuotePayload,
  CloudOptionsChainPayload,
  CloudCompanyProfile,
  CloudFundamentals,
  CloudHoldersPayload,
  CloudAnalystResearchPayload,
  CloudCorporateActionsPayload,
  CloudPricePointPayload,
  CloudEconEventPayload,
  CloudFredSeriesPayload,
  CloudYieldPointPayload,
  CloudCongressHousePayload,
  CloudNewsPayload,
  CloudNewsListResponse,
  CloudTweetSearchResponse,
  CloudMarketResponse,
  CloudMarketBatchTarget,
  CloudMarketBatchPayload,
  CloudVerificationResponse,
  CloudRoundupPreviewResponse,
  CloudSyncPushResponse,
  CloudSyncSnapshotResponse,
  QuoteStreamTarget,
} from "./types";
import type { SyncSettings, SyncSnapshot } from "../sync/types";

export type * from "./types";
export { setCloudApiFetchTransport } from "./request";

class GloomApiClient {
  private currentUser: AuthUser | null = null;
  private readonly transport = new CloudApiRequestTransport();
  private readonly auth: CloudAuthApi;
  private readonly socket: CloudApiSocket;
  private readonly chat: CloudChatApi;
  private readonly data: CloudDataApi;

  constructor() {
    this.auth = new CloudAuthApi({
      getCurrentUser: () => this.currentUser,
      getSessionToken: () => this.transport.getSessionToken(),
      request: (path, options) => this.request(path, options),
      requireCapturedSession: (message) => this.requireCapturedSession(message),
      setCurrentUser: (user) => this.setCurrentUser(user),
      setSessionToken: (token) => this.setSessionToken(token),
      updateCurrentUser: (updater) => this.updateCurrentUser(updater),
    });
    this.socket = new CloudApiSocket({
      getBaseUrl: () => this.transport.baseUrl,
      getSocketAuthToken: () => this.getSocketAuthToken(),
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

  setSessionToken(token: string | null): void {
    const changed = this.transport.getSessionToken() !== token;
    this.transport.setSessionToken(token);
    if (!token) {
      this.currentUser = null;
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

  restoreCachedUser(user: PersistedAuthUser | null): void {
    this.auth.restoreCachedUser(user);
  }

  isVerified(): boolean {
    return !!this.transport.getSessionToken() && !!this.currentUser?.emailVerified;
  }

  private setCurrentUser(user: AuthUser | null): void {
    const changed = this.socketEntitlementKey(this.currentUser) !== this.socketEntitlementKey(user);
    this.currentUser = user;
    this.socket.syncAuthState({ reconnect: changed });
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
    ].join(":");
  }

  private requireCapturedSession(message: string): void {
    if (this.transport.getSessionToken()) return;
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
    return this.auth.ensureVerifiedSession();
  }

  async signUp(email: string, username: string, name: string, password: string): Promise<AuthUser> {
    return this.auth.signUp(email, username, name, password);
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    return this.auth.signIn(email, password);
  }

  async signOut(): Promise<void> {
    return this.auth.signOut();
  }

  async getSession(): Promise<AuthUser | null> {
    return this.auth.getSession();
  }

  async sendVerification(): Promise<CloudVerificationResponse> {
    return this.auth.sendVerification();
  }

  async getAccountProfile(): Promise<AccountProfile> {
    return this.auth.getAccountProfile();
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
