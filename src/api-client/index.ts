import {
  isMarketplaceLayoutId,
  parseMarketplaceLayoutEntry,
  parseMarketplaceLayoutList,
  type LayoutMarketplaceEntry,
  type LayoutMarketplacePayload,
} from "../layout-marketplace/payload";
import type { SyncSettings, SyncSnapshot } from "../sync/types";
import { withDeadline } from "../utils/async-deadline";
import { CloudASKGApi } from "./askg";
import { CloudAuthApi } from "./auth";
import { CloudChatApi } from "./chat";
import { CloudDataApi } from "./data";
import { ApiRequestError } from "./errors";
import { CloudApiRequestTransport } from "./request";
import { CloudApiSocket } from "./socket";
import type {
  AssistCommandDescriptor,
  AssistCommandResponse,
  AuthUser,
  CloudRoundupPreviewResponse,
  CloudSyncPushResponse,
  CloudSyncSnapshotResponse,
  PersistedAuthUser
} from "./types";

export { ASKGTransportError } from "./askg";
export type { ASKGToolResultOutcome, ASKGTransport } from "./askg";
export { setCloudApiFetchTransport } from "./request";
export type * from "./types";

/** Server-side caps for `/assist/command`; enforced here so a 422 is never sent. */
const ASSIST_QUERY_MAX_LENGTH = 200;
const ASSIST_COMMAND_LIMIT = 150;
const ASSIST_REQUEST_TIMEOUT_MS = 6_000;

class GloomApiClient {
  private currentUser: AuthUser | null = null;
  private sessionChecked = false;
  /** Last few session transitions, content-free, for app://auth. */
  private authTrace: Array<{ at: number; event: string; token: boolean; user: string }> = [];
  private sessionRequest: Promise<AuthUser | null> | null = null;
  private readonly currentUserListeners = new Set<() => void>();
  private readonly transport = new CloudApiRequestTransport();
  private readonly auth: CloudAuthApi = new CloudAuthApi({
    getCurrentUser: () => this.currentUser,
    getSessionToken: () => this.transport.getSessionToken(),
    hasSessionCredential: () => this.transport.hasSessionCredential(),
    request: (path, options) => this.request(path, options),
    requireCapturedSession: (message) => this.requireCapturedSession(message),
    setCurrentUser: (user) => this.setCurrentUser(user),
    setSessionToken: (token) => this.setSessionToken(token),
    updateCurrentUser: (updater) => this.updateCurrentUser(updater),
  });
  private readonly socket: CloudApiSocket = new CloudApiSocket({
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
  private readonly chat: CloudChatApi = new CloudChatApi({
    request: (path, options) => this.request(path, options),
    socket: this.socket,
  });
  private readonly data: CloudDataApi = new CloudDataApi((path, options) => this.request(path, options));
  readonly askg: CloudASKGApi = new CloudASKGApi({
    request: (path, options) => this.request(path, options),
    openStream: (path, options) => this.transport.openStream(path, options),
    isStreamingSupported: () => this.transport.isStreamingSupported(),
  });

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
    this.traceAuth(changed ? "setSessionToken:changed" : "setSessionToken:same");
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

  /**
   * What this client currently believes about its session, with no secrets.
   * Exposed over remote control so a "shows my username but not my
   * subscription" report can be answered from the running app instead of
   * from guesses about it.
   */
  describeAuthState(): {
    hasSessionCredential: boolean;
    hasSessionToken: boolean;
    sessionChecked: boolean;
    sessionRequestInFlight: boolean;
    trace: Array<{ at: number; event: string; token: boolean; user: string }>;
    currentUser: {
      id: string;
      emailVerified: boolean;
      plan: string | null;
      effectivePlan: string | null;
      trialEndsAt: string | null;
    } | null;
  } {
    const user = this.currentUser;
    return {
      hasSessionCredential: this.transport.hasSessionCredential(),
      hasSessionToken: !!this.transport.getSessionToken(),
      sessionChecked: this.sessionChecked,
      sessionRequestInFlight: !!this.sessionRequest,
      trace: [...this.authTrace],
      currentUser: user
        ? {
          id: user.id,
          emailVerified: user.emailVerified === true,
          plan: user.plan ?? null,
          effectivePlan: user.effectivePlan ?? null,
          trialEndsAt: user.trialEndsAt ?? null,
        }
        : null,
    };
  }

  private traceAuth(event: string, user: AuthUser | null = this.currentUser): void {
    this.authTrace.push({
      at: Date.now(),
      event,
      token: !!this.transport.getSessionToken(),
      user: user ? (user.emailVerified ? "verified" : "unverified") : "none",
    });
    if (this.authTrace.length > 24) this.authTrace.shift();
  }

  private setCurrentUser(user: AuthUser | null): void {
    const changed = this.socketEntitlementKey(this.currentUser) !== this.socketEntitlementKey(user);
    this.traceAuth("setCurrentUser", user);
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

  signUp = this.auth.signUp.bind(this.auth);
  signIn = this.auth.signIn.bind(this.auth);
  startDeviceSignIn = this.auth.startDeviceSignIn.bind(this.auth);
  pollDeviceSignIn = this.auth.pollDeviceSignIn.bind(this.auth);
  signOut = this.auth.signOut.bind(this.auth);

  async getSession(): Promise<AuthUser | null> {
    if (this.sessionRequest) {
      this.traceAuth("getSession:joined-inflight");
      return this.sessionRequest;
    }
    this.traceAuth("getSession:start");
    this.sessionRequest = this.auth.getSession();
    try {
      const user = await this.sessionRequest;
      this.sessionChecked = true;
      this.traceAuth("getSession:done", user);
      return user;
    } catch (error) {
      this.traceAuth(`getSession:error:${error instanceof Error ? error.message.slice(0, 60) : "unknown"}`);
      throw error;
    } finally {
      this.sessionRequest = null;
    }
  }

  sendVerification = this.auth.sendVerification.bind(this.auth);
  requestPasswordReset = this.auth.requestPasswordReset.bind(this.auth);
  createBrowserHandoff = this.auth.createBrowserHandoff.bind(this.auth);

  /** Creates a Stripe checkout session for Cloud Pro; the URL opens in a browser. */
  async createCloudCheckout(returnTo?: string): Promise<{ url: string }> {
    return this.request<{ url: string }>("/stripe/checkout", { method: "POST", body: JSON.stringify({ returnTo }) });
  }

  async recordResearchActivity(payload: {
    event: import("./research-activity").ResearchActivity; eventId: string;
    surface: "web" | "desktop" | "tui" | "cli"; anonymousId?: string;
    attribution?: Record<string, string>; feature?: import("./research-activity").ResearchFeature;
  }): Promise<void> {
    await this.request("/activity/research", { method: "POST", body: JSON.stringify(payload) });
  }

  /** Stores a verified user's public terminal snapshot or pane handoff. */
  async createTerminalShare(payload: unknown): Promise<{ id: string; expiresAt: string }> {
    return this.request<{ id: string; expiresAt: string }>("/shares", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Stripe billing portal for an account that already has a subscription. */
  async createBillingPortal(): Promise<{ url: string }> {
    return this.request<{ url: string }>("/stripe/portal", { method: "POST", body: JSON.stringify({}) });
  }

  getAccountProfile = this.auth.getAccountProfile.bind(this.auth);
  getCloudPricing = this.auth.getCloudPricing.bind(this.auth);
  getBuildoutAccount = this.auth.getBuildoutAccount.bind(this.auth);
  getBuildoutToken = this.auth.getBuildoutToken.bind(this.auth);
  updateAccountProfile = this.auth.updateAccountProfile.bind(this.auth);

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

  async getMarketplaceLayout(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<LayoutMarketplaceEntry | null> {
    if (!isMarketplaceLayoutId(id)) return null;
    try {
      return parseMarketplaceLayoutEntry(await this.request<unknown>(`/layouts/${encodeURIComponent(id)}`, {
        method: "GET",
        signal: options?.signal,
      }));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async listMarketplaceLayouts(options?: { signal?: AbortSignal }): Promise<LayoutMarketplaceEntry[]> {
    const items = parseMarketplaceLayoutList(await this.request<unknown>("/layouts", {
      method: "GET",
      signal: options?.signal,
    }));
    if (!items) throw new Error("The layout marketplace returned invalid data.");
    return items;
  }

  async publishMarketplaceLayout(
    name: string,
    payload: LayoutMarketplacePayload,
    options?: { signal?: AbortSignal },
  ): Promise<LayoutMarketplaceEntry> {
    const item = parseMarketplaceLayoutEntry(await this.request<unknown>("/layouts", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), ...payload }),
      signal: options?.signal,
    }));
    if (!item) throw new Error("The layout marketplace returned invalid data.");
    return item;
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

  changePassword = this.auth.changePassword.bind(this.auth);
  deleteAccount = this.auth.deleteAccount.bind(this.auth);

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

  getChannels = this.chat.getChannels.bind(this.chat);
  getChatPresence = this.chat.getPresence.bind(this.chat);
  getChatState = this.chat.getState.bind(this.chat);
  updateChatChannelState = this.chat.updateChannelState.bind(this.chat);
  markChatNotificationsDelivered = this.chat.markNotificationsDelivered.bind(this.chat);
  openDirectChannel = this.chat.openDirectChannel.bind(this.chat);
  openGroupChannel = this.chat.openGroupChannel.bind(this.chat);
  getMessages = this.chat.getMessages.bind(this.chat);
  sendMessage = this.chat.sendMessage.bind(this.chat);
  editMessage = this.chat.editMessage.bind(this.chat);
  connectChannel = this.chat.connectChannel.bind(this.chat);
  subscribeChatNotifications = this.chat.subscribeNotifications.bind(this.chat);
  subscribeChatPresence = this.chat.subscribePresence.bind(this.chat);
  subscribeQuotes = this.socket.subscribeQuotes.bind(this.socket);

  /** Subscribes to a shared scanner feed; all panes of one kind share one upstream subscription. */
  subscribeScanner = this.socket.subscribeScanner.bind(this.socket);

  dispose(): void {
    this.socket.dispose();
  }

  searchInstruments = this.data.searchInstruments.bind(this.data);
  getCloudQuote = this.data.getCloudQuote.bind(this.data);
  getCloudQuotesBatch = this.data.getCloudQuotesBatch.bind(this.data);
  getCloudWorldVenues = this.data.getCloudWorldVenues.bind(this.data);
  getCloudMarketScreener = this.data.getCloudMarketScreener.bind(this.data);
  getCloudOptionsChain = this.data.getCloudOptionsChain.bind(this.data);
  getCloudProfile = this.data.getCloudProfile.bind(this.data);
  getCloudFundamentals = this.data.getCloudFundamentals.bind(this.data);
  getCloudFinancials = this.data.getCloudFinancials.bind(this.data);
  getCloudFinancialsBatch = this.data.getCloudFinancialsBatch.bind(this.data);
  getCloudHolders = this.data.getCloudHolders.bind(this.data);
  getCloudShortInterest = this.data.getCloudShortInterest.bind(this.data);
  getCloudAnalystResearch = this.data.getCloudAnalystResearch.bind(this.data);
  getCloudCorporateActions = this.data.getCloudCorporateActions.bind(this.data);
  getCloudStatements = this.data.getCloudStatements.bind(this.data);
  getCloudHistory = this.data.getCloudHistory.bind(this.data);
  getCloudExchangeRate = this.data.getCloudExchangeRate.bind(this.data);
  getCloudEconomicCalendar = this.data.getCloudEconomicCalendar.bind(this.data);
  getCloudEquityDiagnostic = this.data.getCloudEquityDiagnostic.bind(this.data);
  getCloudFredSeries = this.data.getCloudFredSeries.bind(this.data);
  getCloudShiller = this.data.getCloudShiller.bind(this.data);
  getCloudYieldCurve = this.data.getCloudYieldCurve.bind(this.data);
  getCloudCds = this.data.getCloudCds.bind(this.data);
  getCloudCongressHouse = this.data.getCloudCongressHouse.bind(this.data);
  getCloudEarningsCalls = this.data.getCloudEarningsCalls.bind(this.data);
  getCloudEarningsTranscript = this.data.getCloudEarningsTranscript.bind(this.data);
  getProxyStatements = this.data.getProxyStatements.bind(this.data);
  getProxyStatement = this.data.getProxyStatement.bind(this.data);
  getFilingEvents = this.data.getFilingEvents.bind(this.data);
  getRiskReports = this.data.getRiskReports.bind(this.data);
  getRiskReport = this.data.getRiskReport.bind(this.data);
  getCloudSecFilings = this.data.getCloudSecFilings.bind(this.data);
  getCloudSecFilingDocuments = this.data.getCloudSecFilingDocuments.bind(this.data);
  getCloudSecFilingContent = this.data.getCloudSecFilingContent.bind(this.data);
  getCloudSec13F = this.data.getCloudSec13F.bind(this.data);
  searchCloudDocuments = this.data.searchCloudDocuments.bind(this.data);
  getCloudSearchDocument = this.data.getCloudSearchDocument.bind(this.data);
  getCloudSavedSearches = this.data.getCloudSavedSearches.bind(this.data);
  createCloudSavedSearch = this.data.createCloudSavedSearch.bind(this.data);
  updateCloudSavedSearch = this.data.updateCloudSavedSearch.bind(this.data);
  deleteCloudSavedSearch = this.data.deleteCloudSavedSearch.bind(this.data);
  getCloudSavedSearchHits = this.data.getCloudSavedSearchHits.bind(this.data);
  getCloudNews = this.data.getCloudNews.bind(this.data);
  getCloudNewsStory = this.data.getCloudNewsStory.bind(this.data);
  getCloudTickerTweets = this.data.getCloudTickerTweets.bind(this.data);
  searchCloudTweets = this.data.searchCloudTweets.bind(this.data);
}

export const apiClient = new GloomApiClient();
