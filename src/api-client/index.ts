import {
  isMarketplaceLayoutId,
  parseMarketplaceLayoutEntry,
  parseMarketplaceLayoutList,
  type LayoutMarketplaceEntry,
  type LayoutMarketplacePayload,
} from "../layout-marketplace/payload";
import {
  type CloudLayoutEntry,
  type CloudLayoutRevisionSummary,
  type CloudLayoutVisibility,
  type LayoutRequirement,
  LayoutRevisionConflictError,
  parseCloudLayoutEntry,
  parseCloudLayoutList,
  parseCloudLayoutRevisions,
} from "../layout-marketplace/cloud";
import type { SyncSettings, SyncSnapshot } from "../sync/types";
import { withDeadline } from "../utils/async-deadline";
import { CloudASKGApi } from "./askg";
import { CloudAuthApi } from "./auth";
import { CloudChatApi } from "./chat";
import { CloudDataApi } from "./data";
import { ApiRequestError } from "./errors";
import { CloudApiRequestTransport } from "./request";
import { CloudApiSocket } from "./socket";
import { CloudCollectionsApi } from "./collections";
import { CloudNotesApi } from "./notes";
import { CloudTeamsApi } from "./teams";
import { CloudThesesApi } from "./theses";
import { CloudViewsApi } from "./views";
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
export { NoteConflictError } from "./notes";
export { ThesisConflictError, ThesisGoalpostError } from "./theses";
export { TeamRevisionConflictError } from "./views";
export { TEAM_ACCENT_COLORS } from "./types";
export type * from "./types";

/** Server-side caps for `/assist/command`; enforced here so a 422 is never sent. */
const ASSIST_QUERY_MAX_LENGTH = 200;
const ASSIST_COMMAND_LIMIT = 150;
const ASSIST_REQUEST_TIMEOUT_MS = 6_000;

interface PendingSessionRequest {
  promise: Promise<AuthUser | null>;
  consumers: Array<() => boolean>;
  isCurrent: () => boolean;
  user: AuthUser | null;
  credential: string | null;
}

class GloomApiClient {
  private currentUser: AuthUser | null = null;
  private sessionChecked = false;
  /** Last few session transitions, content-free, for app://auth. */
  private authTrace: Array<{ at: number; event: string; token: boolean; user: string }> = [];
  private sessionRequest: PendingSessionRequest | null = null;
  private sessionRequestGeneration = 0;
  private readonly currentUserListeners = new Set<() => void>();
  private readonly transport = new CloudApiRequestTransport();
  private readonly auth: CloudAuthApi = new CloudAuthApi({
    getCurrentUser: () => this.currentUser,
    getSessionToken: () => this.transport.getSessionToken(),
    hasSessionCredential: () => this.transport.hasSessionCredential(),
    request: (path, options, canApplySession) => this.request(path, options, canApplySession),
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
  private readonly teams: CloudTeamsApi = new CloudTeamsApi({
    request: (path, options) => this.request(path, options),
    socket: this.socket,
  });
  private readonly data: CloudDataApi = new CloudDataApi((path, options) => this.request(path, options));
  private readonly notes: CloudNotesApi = new CloudNotesApi((path, options) => this.request(path, options));
  private readonly theses: CloudThesesApi = new CloudThesesApi((path, options) => this.request(path, options));
  private readonly collections: CloudCollectionsApi = new CloudCollectionsApi((path, options) => this.request(path, options));
  private readonly views: CloudViewsApi = new CloudViewsApi((path, options) => this.request(path, options));
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

  private async request<T>(path: string, options?: RequestInit, canApplySession?: () => boolean): Promise<T> {
    return this.transport.request<T>(path, options, canApplySession);
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

  async getSession(isCurrent: () => boolean = () => true): Promise<AuthUser | null> {
    if (!isCurrent()) return this.currentUser;
    const existing = this.sessionRequest;
    if (existing?.isCurrent()
      && existing.user === this.currentUser
      && existing.credential === this.getSessionToken()) {
      existing.consumers.push(isCurrent);
      this.traceAuth("getSession:joined-inflight");
      return existing.promise;
    }
    this.traceAuth("getSession:start");
    const generation = ++this.sessionRequestGeneration;
    const consumers = [isCurrent];
    const canApply = () => generation === this.sessionRequestGeneration && consumers.some((consumer) => consumer());
    const request: PendingSessionRequest = {
      consumers,
      isCurrent: canApply,
      user: this.currentUser,
      credential: this.getSessionToken(),
      promise: this.auth.getSession(canApply)
        .then(({ user, validated }) => {
          if (validated && canApply()) this.sessionChecked = true;
          this.traceAuth(validated ? "getSession:done" : "getSession:retained", user);
          return user;
        })
        .catch((error) => {
          this.traceAuth(`getSession:error:${error instanceof Error ? error.message.slice(0, 60) : "unknown"}`);
          throw error;
        })
        .finally(() => {
          if (this.sessionRequest === request) this.sessionRequest = null;
        }),
    };
    this.sessionRequest = request;
    return request.promise;
  }

  sendVerification = this.auth.sendVerification.bind(this.auth);
  requestPasswordReset = this.auth.requestPasswordReset.bind(this.auth);
  createBrowserHandoff = this.auth.createBrowserHandoff.bind(this.auth);

  /** Creates a Stripe checkout session for Cloud Pro; the URL opens in a browser. */
  async createCloudCheckout(returnTo?: string, interval: "month" | "year" = "month"): Promise<{ url: string }> {
    return this.request<{ url: string }>("/stripe/checkout", { method: "POST", body: JSON.stringify({ returnTo, interval }) });
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

  // Cloud layouts: the full, revisioned shape behind ?v=2 and the new routes.

  async getCloudLayout(id: string, options?: { signal?: AbortSignal }): Promise<CloudLayoutEntry | null> {
    if (!isMarketplaceLayoutId(id)) return null;
    try {
      return parseCloudLayoutEntry(await this.request<unknown>(`/layouts/${encodeURIComponent(id)}?v=2`, {
        method: "GET",
        signal: options?.signal,
      }));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async listMyCloudLayouts(options?: { signal?: AbortSignal }): Promise<CloudLayoutEntry[]> {
    const items = parseCloudLayoutList(await this.request<unknown>("/layouts/mine", {
      method: "GET",
      signal: options?.signal,
    }));
    if (!items) throw new Error("The layout service returned invalid data.");
    return items;
  }

  async listTeamLayouts(teamId: string, options?: { signal?: AbortSignal }): Promise<CloudLayoutEntry[]> {
    const items = parseCloudLayoutList(await this.request<unknown>(`/teams/${encodeURIComponent(teamId)}/layouts`, {
      method: "GET",
      signal: options?.signal,
    }));
    if (!items) throw new Error("The layout service returned invalid data.");
    return items;
  }

  async publishTeamLayout(
    teamId: string,
    name: string,
    payload: LayoutMarketplacePayload,
    options: { requires?: LayoutRequirement[]; note?: string | null; visibility?: "team" | "public" } = {},
  ): Promise<CloudLayoutEntry> {
    const item = parseCloudLayoutEntry(await this.request<unknown>(`/teams/${encodeURIComponent(teamId)}/layouts`, {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        ...payload,
        requires: options.requires ?? [],
        ...(options.note ? { note: options.note } : {}),
        ...(options.visibility ? { visibility: options.visibility } : {}),
      }),
    }));
    if (!item) throw new Error("The layout service returned invalid data.");
    return item;
  }

  /**
   * Appends a revision. `expectedRevision` is sent as If-Match; a 412 becomes
   * a LayoutRevisionConflictError carrying the revision the server holds now.
   */
  async publishLayoutRevision(
    id: string,
    payload: LayoutMarketplacePayload,
    options: { expectedRevision?: number; requires?: LayoutRequirement[]; note?: string | null; name?: string } = {},
  ): Promise<CloudLayoutEntry> {
    try {
      const item = parseCloudLayoutEntry(await this.request<unknown>(`/layouts/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: options.expectedRevision ? { "if-match": String(options.expectedRevision) } : {},
        body: JSON.stringify({
          ...payload,
          requires: options.requires ?? [],
          ...(options.note ? { note: options.note } : {}),
          ...(options.name ? { name: options.name } : {}),
        }),
      }));
      if (!item) throw new Error("The layout service returned invalid data.");
      return item;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 412) {
        const current = await this.getCloudLayout(id).catch(() => null);
        throw new LayoutRevisionConflictError(error.message, current?.revision ?? (options.expectedRevision ?? 0) + 1);
      }
      throw error;
    }
  }

  async updateCloudLayout(
    id: string,
    patch: { name?: string; visibility?: CloudLayoutVisibility },
  ): Promise<CloudLayoutEntry> {
    const item = parseCloudLayoutEntry(await this.request<unknown>(`/layouts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }));
    if (!item) throw new Error("The layout service returned invalid data.");
    return item;
  }

  async deleteCloudLayout(id: string): Promise<void> {
    await this.request<unknown>(`/layouts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listCloudLayoutRevisions(id: string): Promise<CloudLayoutRevisionSummary[]> {
    const items = parseCloudLayoutRevisions(await this.request<unknown>(`/layouts/${encodeURIComponent(id)}/revisions`, {
      method: "GET",
    }));
    if (!items) throw new Error("The layout service returned invalid data.");
    return items;
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

  listTeams = this.teams.listTeams.bind(this.teams);
  createTeam = this.teams.createTeam.bind(this.teams);
  getTeamMembers = this.teams.getTeamMembers.bind(this.teams);
  inviteTeamMemberByUsername = this.teams.inviteTeamMemberByUsername.bind(this.teams);
  listTeamInviteLinks = this.teams.listTeamInviteLinks.bind(this.teams);
  createTeamInviteLink = this.teams.createTeamInviteLink.bind(this.teams);
  deleteTeamInviteLink = this.teams.deleteTeamInviteLink.bind(this.teams);
  previewTeamInviteLink = this.teams.previewTeamInviteLink.bind(this.teams);
  joinTeamThroughLink = this.teams.joinTeamThroughLink.bind(this.teams);
  getTeamNotifications = this.teams.getTeamNotifications.bind(this.teams);
  listTeamInvitations = this.teams.listTeamInvitations.bind(this.teams);
  listMyTeamInvitations = this.teams.listMyTeamInvitations.bind(this.teams);
  acceptTeamInvitation = this.teams.acceptTeamInvitation.bind(this.teams);
  rejectTeamInvitation = this.teams.rejectTeamInvitation.bind(this.teams);
  cancelTeamInvitation = this.teams.cancelTeamInvitation.bind(this.teams);
  updateTeam = this.teams.updateTeam.bind(this.teams);
  updateTeamMemberRole = this.teams.updateTeamMemberRole.bind(this.teams);
  removeTeamMember = this.teams.removeTeamMember.bind(this.teams);
  leaveTeam = this.teams.leaveTeam.bind(this.teams);
  deleteTeam = this.teams.deleteTeam.bind(this.teams);
  listTeamChannels = this.teams.listTeamChannels.bind(this.teams);
  createTeamChannel = this.teams.createTeamChannel.bind(this.teams);
  deleteTeamChannel = this.teams.deleteTeamChannel.bind(this.teams);
  subscribeTeamUpdates = this.teams.subscribeTeamUpdates.bind(this.teams);
  subscribeTeamNotifications = this.teams.subscribeTeamNotifications.bind(this.teams);
  subscribeCloudEvent = this.teams.subscribeCloudEvent.bind(this.teams);
  listCloudNotes = this.notes.listNotes.bind(this.notes);
  getCloudNote = this.notes.getNote.bind(this.notes);
  putCloudNote = this.notes.putNote.bind(this.notes);
  deleteCloudNote = this.notes.deleteNote.bind(this.notes);
  listTheses = this.theses.listTheses.bind(this.theses);
  getThesis = this.theses.getThesis.bind(this.theses);
  createThesis = this.theses.createThesis.bind(this.theses);
  updateThesis = this.theses.updateThesis.bind(this.theses);
  deleteThesis = this.theses.deleteThesis.bind(this.theses);
  listThesisRevisions = this.theses.listThesisRevisions.bind(this.theses);
  listThesisSignals = this.theses.listThesisSignals.bind(this.theses);
  createThesisSignal = this.theses.createThesisSignal.bind(this.theses);
  resolveThesisSignal = this.theses.resolveThesisSignal.bind(this.theses);
  reviewThesis = this.theses.reviewThesis.bind(this.theses);
  draftThesis = this.theses.draftThesis.bind(this.theses);
  listTeamCollections = this.collections.listTeamCollections.bind(this.collections);
  getTeamCollection = this.collections.getTeamCollection.bind(this.collections);
  createTeamCollection = this.collections.createTeamCollection.bind(this.collections);
  updateTeamCollection = this.collections.updateTeamCollection.bind(this.collections);
  deleteTeamCollection = this.collections.deleteTeamCollection.bind(this.collections);
  putTeamCollectionItem = this.collections.putTeamCollectionItem.bind(this.collections);
  removeTeamCollectionItem = this.collections.removeTeamCollectionItem.bind(this.collections);
  listTeamViews = this.views.listTeamViews.bind(this.views);
  getTeamView = this.views.getTeamView.bind(this.views);
  createTeamView = this.views.createTeamView.bind(this.views);
  publishTeamViewRevision = this.views.publishTeamViewRevision.bind(this.views);
  renameTeamView = this.views.renameTeamView.bind(this.views);
  deleteTeamView = this.views.deleteTeamView.bind(this.views);
  listTeamPluginState = this.views.listTeamPluginState.bind(this.views);
  getTeamPluginState = this.views.getTeamPluginState.bind(this.views);
  putTeamPluginState = this.views.putTeamPluginState.bind(this.views);
  deleteTeamPluginState = this.views.deleteTeamPluginState.bind(this.views);

  /** Subscribes to a shared scanner feed; all panes of one kind share one upstream subscription. */
  subscribeTape = this.socket.subscribeTape.bind(this.socket);
  subscribeScanner = this.socket.subscribeScanner.bind(this.socket);

  dispose(): void {
    this.sessionRequestGeneration += 1;
    this.sessionRequest = null;
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
  getCloudCryptoBoard = this.data.getCloudCryptoBoard.bind(this.data);
  getCloudCentralBankRates = this.data.getCloudCentralBankRates.bind(this.data);
  getMobileAlertHistory = this.data.getMobileAlertHistory.bind(this.data);
  getCloudEstimateRevisions = this.data.getCloudEstimateRevisions.bind(this.data);
  getCloudMoneyMarkets = this.data.getCloudMoneyMarkets.bind(this.data);
  equityScreener = this.data.equityScreener.bind(this.data);
  getCloudDebtMaturities = this.data.getCloudDebtMaturities.bind(this.data);
  getCloudShortVolume = this.data.getCloudShortVolume.bind(this.data);
  getCloudFuturesCurve = this.data.getCloudFuturesCurve.bind(this.data);
  getCloudRatePath = this.data.getCloudRatePath.bind(this.data);
  getCloudShiller = this.data.getCloudShiller.bind(this.data);
  getCloudCotBoard = this.data.getCloudCotBoard.bind(this.data);
  getCloudCotContract = this.data.getCloudCotContract.bind(this.data);
  getCloudTape = this.data.getCloudTape.bind(this.data);
  getCloudYieldCurve = this.data.getCloudYieldCurve.bind(this.data);
  getCloudCds = this.data.getCloudCds.bind(this.data);
  getCloudCongressHouse = this.data.getCloudCongressHouse.bind(this.data);
  getCloudJobs = this.data.getCloudJobs.bind(this.data);
  getCloudJobsPostings = this.data.getCloudJobsPostings.bind(this.data);
  getCloudJobsMovers = this.data.getCloudJobsMovers.bind(this.data);
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

export type { FuturesCurvePayload, FuturesContract } from "./futures-curve";
