import { getLanguage } from "../i18n";
import { logFailure } from "../utils/log-failure";
import {
  isMarketplaceLayoutId,
  parseMarketplaceLayoutEntry,
  parseMarketplaceLayoutList,
  type LayoutMarketplaceEntry,
  type LayoutMarketplacePayload,
} from "../shares/portable-layout";
import {
  type CloudLayoutEntry,
  type LayoutRequirement,
  LayoutRevisionConflictError,
  parseCloudLayoutEntry,
  parseCloudLayoutList,
} from "../layout-marketplace/cloud";
import { SyncRevisionConflictError, type SyncSnapshot } from "../sync/types";
import { withDeadline } from "../utils/async-deadline";
import { createListenerSet } from "../utils/listeners";
import { sliceWholeCharacters } from "../utils/untrusted-text";
import { CloudASKGApi } from "./askg";
import { CloudAuthApi } from "./auth";
import { CloudChatApi } from "./chat";
import { CloudDataApi } from "./data";
import { ApiRequestError } from "./errors";
import { CloudApiRequestTransport, putWithRevision } from "./request";
import { CloudApiSocket } from "./socket";
import { CloudCollectionsApi } from "./collections";
import { CloudFeedbackApi } from "./feedback";
import { CloudRoadmapApi } from "./roadmap";
import { CloudWaitlistApi } from "./product-waitlist";
import { CloudHeardFromApi } from "./heard-from";
import { CloudNotesApi } from "./notes";
import { CloudTeamsApi } from "./teams";
import { CloudTelemetryApi } from "./telemetry";
import { CloudThesesApi } from "./theses";
import { CloudViewsApi } from "./views";
import { readYearlyPlanStatus, readYearlyResult, readYearlyReview } from "./yearly-plan";
import type { CommandSearchReport } from "./telemetry";
import type {
  AssistCommandDescriptor,
  AssistCommandResponse,
  AuthUser,
  CloudCancelFeedback,
  CloudRetentionOffer,
  CloudRetentionOfferAnswer,
  CloudSyncPushResponse,
  CloudYearlyPlanStatus,
  CloudYearlyResult,
  CloudYearlyReview,
  CloudSyncSnapshotResponse,
  PersistedAuthUser
} from "./types";

export { setCloudApiFetchTransport, setCloudApiUploadTransport } from "./request";
export type { ChatAttachmentUpload } from "./chat";
export type { ChatPaneLink } from "./chat-pane-link";
export { NoteConflictError } from "./notes";
export { ThesisConflictError, ThesisGoalpostError } from "./theses";
export { TeamRevisionConflictError } from "./views";
export { yearlyRefusalCode } from "./yearly-plan";
export type * from "./types";
export type {
  CommandSearchChoice,
  CommandSearchOutcome,
  CrashReportError,
  CrashReportKind,
  CrashReportSurface,
  CrashReportsPayload,
  FunctionUsageCount,
  InstallExperimentAnswer,
  InstallExperimentReport,
  UpdateFailureReport,
  UsageCountsPayload,
  UsageCountsSurface,
} from "./telemetry";

/** Server-side caps for `/assist/command`; enforced here so a 422 is never sent. */
const ASSIST_QUERY_MAX_LENGTH = 200;
const ASSIST_COMMAND_LIMIT = 150;
/** The futures curve's root list is the longest a command sends: 76. */
export const ASSIST_ARG_OPTION_LIMIT = 128;
/** The longest cancel note the server keeps, in UTF-16 units as its schema counts them. */
export const CLOUD_CANCEL_COMMENT_MAX = 500;

/** The reason and note a cancel step sends, the note trimmed to what the server keeps. */
function cancelFeedbackBody(feedback: CloudCancelFeedback): CloudCancelFeedback {
  const comment = feedback.comment === undefined ? undefined : sliceWholeCharacters(feedback.comment.trim(), CLOUD_CANCEL_COMMENT_MAX);
  return {
    ...(feedback.reason ? { reason: feedback.reason } : {}),
    ...(comment ? { comment } : {}),
  };
}
const ASSIST_ARG_OPTION_VALUE_MAX_LENGTH = 40;
const ASSIST_ARG_OPTION_LABEL_MAX_LENGTH = 60;
const ASSIST_REQUEST_TIMEOUT_MS = 6_000;
const SESSION_REVALIDATION_INITIAL_MS = 1_000;
const SESSION_REVALIDATION_MAX_MS = 30_000;

/**
 * Fits a command's argument values inside the server caps. The value is what
 * the bar runs, so one that is too long is dropped rather than cut; the label
 * only describes it and is truncated. A list still over the cap is left out
 * whole: the assistant would read a partial list as every value there is.
 */
function capAssistArgOptions(command: AssistCommandDescriptor): AssistCommandDescriptor {
  if (!command.arg?.options) return command;
  const { options, ...arg } = command.arg;
  const capped = options
    .filter(({ value }) => value.length > 0 && value.length <= ASSIST_ARG_OPTION_VALUE_MAX_LENGTH)
    .map(({ value, label }) => ({ value, label: label.slice(0, ASSIST_ARG_OPTION_LABEL_MAX_LENGTH) }));
  const fits = capped.length > 0 && capped.length <= ASSIST_ARG_OPTION_LIMIT;
  return { ...command, arg: fits ? { ...arg, options: capped } : arg };
}

/** Whether a socket's account fields differ from the user held now; a field it leaves out changes nothing. */
function changesUser(current: AuthUser, update: Partial<AuthUser>): boolean {
  const held = current as unknown as Record<string, unknown>;
  return Object.entries(update).some(([key, value]) => {
    const before = held[key];
    if (Object.is(before, value)) return false;
    if (!before || !value || typeof before !== "object" || typeof value !== "object") return true;
    return JSON.stringify(before) !== JSON.stringify(value);
  });
}

interface PendingSessionRequest {
  promise: Promise<AuthUser | null>;
  consumers: Array<() => boolean>;
  isCurrent: () => boolean;
  user: AuthUser | null;
  credential: string | null;
}

type SubApiMethods<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K];
};

type MappedSubApi<T, M extends Record<string, keyof T>> = {
  -readonly [K in keyof M]: T[M[K]];
};

const CHAT_METHOD_MAP = {
  getChannels: "getChannels",
  getChatPresence: "getPresence",
  getChatState: "getState",
  getChatMentionCandidates: "getMentionCandidates",
  subscribeChatMentionCandidatesChanged: "subscribeMentionCandidatesChanged",
  updateChatChannelState: "updateChannelState",
  markChatNotificationsDelivered: "markNotificationsDelivered",
  getUnseenChatNotificationIds: "getUnseenNotificationIds",
  openDirectChannel: "openDirectChannel",
  openGroupChannel: "openGroupChannel",
  getMessages: "getMessages",
  sendMessage: "sendMessage",
  uploadChatAttachment: "uploadAttachment",
  chatAttachmentsSupported: "attachmentsSupported",
  subscribeChatAttachmentSupport: "subscribeAttachmentSupport",
  editMessage: "editMessage",
  setChatReaction: "setReaction",
  subscribeChatReactions: "subscribeReactions",
  connectChannel: "connectChannel",
  subscribeChatNotifications: "subscribeNotifications",
  subscribeChatChannelState: "subscribeChannelState",
  subscribeChatPresence: "subscribePresence",
  getChatDiscordLink: "getDiscordLink",
  unlinkChatDiscord: "unlinkDiscord",
  setChatDiscordMirror: "setDiscordMirror",
} as const satisfies Record<string, keyof CloudChatApi>;

const SOCKET_METHOD_MAP = {
  subscribeQuotes: "subscribeQuotes",
  subscribeSocketConnection: "subscribeConnection",
  sendSocketFrame: "sendFrame",
  socketServerOffers: "serverOffers",
  subscribeTape: "subscribeTape",
  subscribeScanner: "subscribeScanner",
} as const satisfies Record<string, keyof CloudApiSocket>;

const NOTES_METHOD_MAP = {
  listCloudNotes: "listNotes",
  getCloudNote: "getNote",
  putCloudNote: "putNote",
  deleteCloudNote: "deleteNote",
} as const satisfies Record<string, keyof CloudNotesApi>;

function parseRetentionOfferBase(body: { offer?: unknown; extendedTrialEndsAt?: unknown } | null): {
  offer: CloudRetentionOffer | null;
  extendedTrialEndsAt: string | null;
} {
  return {
    offer: body?.offer === "discount" || body?.offer === "trial_extension" ? body.offer : null,
    extendedTrialEndsAt: typeof body?.extendedTrialEndsAt === "string" ? body.extendedTrialEndsAt : null,
  };
}

function requireLayoutData<T>(value: T | null, errorMessage: string): T {
  if (!value) throw new Error(errorMessage);
  return value;
}

interface GloomApiClient
  extends Omit<SubApiMethods<CloudAuthApi>, "restoreCachedUser" | "signUp" | "signIn" | "signInWithGoogle" | "signOut" | "getSession">,
    SubApiMethods<CloudDataApi>,
    SubApiMethods<CloudTeamsApi>,
    SubApiMethods<CloudThesesApi>,
    SubApiMethods<CloudCollectionsApi>,
    SubApiMethods<CloudViewsApi>,
    SubApiMethods<CloudFeedbackApi>,
    SubApiMethods<CloudRoadmapApi>,
    SubApiMethods<CloudWaitlistApi>,
    SubApiMethods<CloudHeardFromApi>,
    Omit<SubApiMethods<CloudTelemetryApi>, "reportCommandSearch">,
    MappedSubApi<CloudChatApi, typeof CHAT_METHOD_MAP>,
    MappedSubApi<CloudApiSocket, typeof SOCKET_METHOD_MAP>,
    MappedSubApi<CloudNotesApi, typeof NOTES_METHOD_MAP> {}

class GloomApiClient {
  private currentUser: AuthUser | null = null;
  /** Local user/credential binding, masked until verified and never serialized. */
  private verifiedSessionIdentity: object | null = null;
  private verifiedSessionCredential: string | null = null;
  private socketUnverifiedUser: AuthUser | null = null;
  private sessionTransitions = 0;
  private sessionTransition: Promise<void> | null = null;
  /** Device adoption and external session installs supersede pending email auth. */
  private sessionInstallationGeneration = 0;
  /** Set while this client replaces the credential itself: it tells listeners once its own state is in place. */
  private replacingCredential = false;
  private sessionRevalidationGeneration = 0;
  private sessionRevalidationTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionChecked = false;
  private cookieIdentity: "ready" | "pending" | "unavailable" = "ready";
  /** When a session check last answered for the credential in place (`recentSession`). */
  private sessionCheckedAt: number | null = null;
  /** Last few session transitions, content-free, for app://auth. */
  private authTrace: Array<{ at: number; event: string; token: boolean; user: string }> = [];
  private sessionRequest: PendingSessionRequest | null = null;
  private sessionRequestGeneration = 0;
  private readonly currentUserListeners = createListenerSet();
  private readonly transport = new CloudApiRequestTransport({ onCredentialChange: () => this.credentialReplaced() });
  private readonly auth: CloudAuthApi = new CloudAuthApi({
    getCurrentUser: () => this.currentUser,
    getSessionToken: () => this.transport.getSessionToken(),
    hasSessionCredential: () => this.transport.hasSessionCredential(),
    isCookieSessionMode: () => this.transport.isCookieSessionMode(),
    request: (path, options, canApplySession) => this.request(path, options, canApplySession),
    requireCapturedSession: (message) => this.requireCapturedSession(message),
    setCurrentUser: (user, confirmSession) => this.setCurrentUser(user, confirmSession),
    setSessionToken: (token) => this.installSessionToken(token),
    updateCurrentUser: (updater) => this.updateCurrentUser(updater),
  });
  private readonly socket: CloudApiSocket = new CloudApiSocket({
    getBaseUrl: () => this.transport.baseUrl,
    getSocketAuthToken: () => this.getSocketAuthToken(),
    hasSessionCredential: () => this.transport.hasSessionCredential(),
    hasVerifiedUser: () => this.getCurrentUser()?.emailVerified === true,
    isUsingWebSocketToken: () => !!this.transport.getWebSocketToken(),
    clearWebSocketTokenForFallback: () => this.transport.clearWebSocketTokenForFallback(),
    markCurrentUserUnverified: () => {
      if (this.currentUser && !this.socketUnverifiedUser) {
        this.socketUnverifiedUser = { ...this.currentUser, emailVerified: false };
        this.emitCurrentUserChange();
      }
    },
    updateCurrentUserFromSocket: (user, { resync }) => {
      // Every connection's hello repeats the account. A reconnect that changes
      // nothing must not tell every listener the user changed: each would load
      // its data again (teams, theses, sync), and after a server restart every
      // client reconnects at once. After a long silence they do load again, for
      // what changed while nothing arrived.
      const confirmsVerification = this.socketUnverifiedUser !== null && typeof user.emailVerified === "boolean";
      if (!this.currentUser || (!resync && !confirmsVerification && !changesUser(this.currentUser, user))) return;
      this.updateCurrentUser((currentUser) => ({
        ...currentUser,
        ...user,
      }), confirmsVerification);
    },
    onServiceAnswered: () => this.transport.noteServiceAnswered(),
  });
  private readonly chat: CloudChatApi = new CloudChatApi({
    request: (path, options) => this.request(path, options),
    upload: (path, body, options) => this.transport.upload(path, body, options),
    socket: this.socket,
  });
  private readonly teams: CloudTeamsApi = new CloudTeamsApi({
    request: (path, options) => this.request(path, options),
    socket: this.socket,
  });
  private readonly data: CloudDataApi = new CloudDataApi((path, options) => this.request(path, options));
  private readonly notes: CloudNotesApi = new CloudNotesApi((path, options) => this.request(path, options));
  private readonly feedback: CloudFeedbackApi = new CloudFeedbackApi((path, options) => this.request(path, options));
  private readonly roadmap: CloudRoadmapApi = new CloudRoadmapApi((path, options) => this.request(path, options));
  private readonly waitlist: CloudWaitlistApi = new CloudWaitlistApi((path, options) => this.request(path, options));
  private readonly heardFrom: CloudHeardFromApi = new CloudHeardFromApi((path, options) => this.request(path, options));
  private readonly telemetry: CloudTelemetryApi = new CloudTelemetryApi((path, options) => this.request(path, options));
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

  /**
   * Changes each time the session credential is replaced (a token installed, changed or cleared, one taken from a
   * response's headers, the cookie mode switched), before the account it belongs to is known: a non-secret count,
   * for answers that must not outlive the credential they were sent with.
   */
  getCredentialGeneration(): number {
    return this.transport.getCredentialGeneration();
  }

  /**
   * The transport replaced the credential. Taken from a response's headers, listeners are told now, with the body
   * still out and the account it belongs to not read yet; replaced here, they are told once by the caller.
   */
  private credentialReplaced(): void {
    if (this.replacingCredential) return;
    this.traceAuth("sessionToken:fromResponse");
    this.emitCurrentUserChange();
  }

  /** Replaces the credential in the transport without telling listeners: the caller does, once its state is set. */
  private replaceCredential(replace: () => void): void {
    this.replacingCredential = true;
    try {
      replace();
    } finally {
      this.replacingCredential = false;
    }
  }

  setCookieSessionMode(enabled: boolean): void {
    this.cancelSessionRevalidation();
    this.sessionInstallationGeneration += 1;
    this.sessionChecked = false;
    this.cookieIdentity = "ready";
    this.verifiedSessionIdentity = null;
    this.replaceCredential(() => this.transport.setCookieSessionMode(enabled));
    this.emitCurrentUserChange();
  }

  setSessionToken(token: string | null): void {
    if (this.transport.getSessionToken() !== token || !token) {
      this.cancelSessionRevalidation();
      this.sessionInstallationGeneration += 1;
    }
    this.installSessionToken(token);
  }

  private installSessionToken(token: string | null): void {
    const changed = this.transport.getSessionToken() !== token;
    this.sessionChecked = false;
    this.replaceCredential(() => this.transport.setSessionToken(token));
    if (changed) this.verifiedSessionIdentity = null;
    this.traceAuth(changed ? "setSessionToken:changed" : "setSessionToken:same");
    if (!token) {
      this.cancelSessionRevalidation();
      this.currentUser = null;
      this.socketUnverifiedUser = null;
      this.verifiedSessionIdentity = null;
    }
    if (changed || !token) {
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
    return this.socketUnverifiedUser ?? this.currentUser;
  }

  /**
   * Whether a signed-in session exists on this surface. Browser builds keep the
   * session in an HttpOnly cookie, so the raw token is deliberately null there
   * and the restored user is the only signal.
   */
  isSignedIn(): boolean {
    return !!this.transport.getSessionToken() || !!this.currentUser;
  }

  /**
   * Whether a request sent now carries a session: the token this client
   * holds, or, in the browser, the cookie it cannot see and assumes is there.
   */
  hasSessionCredential(): boolean {
    return this.transport.hasSessionCredential();
  }

  /** Notifies when the user or credential changes, including plan and trial entitlement. */
  subscribeCurrentUser(listener: () => void): () => void {
    return this.currentUserListeners.subscribe(listener);
  }

  restoreCachedUser(user: PersistedAuthUser | null, confirmSession = true): void {
    this.auth.restoreCachedUser(user, confirmSession);
  }

  waitForCookieIdentity(): void {
    this.cookieIdentity = "pending";
    this.emitCurrentUserChange();
  }

  finishCookieIdentityBoot(): void {
    if (this.cookieIdentity !== "pending" || this.currentUser) return;
    const generation = this.sessionRevalidationGeneration;
    this.cookieIdentity = "unavailable";
    this.transport.forgetSharedReads();
    this.emitCurrentUserChange();
    this.scheduleSessionRevalidation(generation);
  }

  isCookieIdentityUnavailable(): boolean {
    return this.cookieIdentity === "unavailable";
  }

  isChangingSession(): boolean {
    return this.sessionTransitions > 0;
  }

  isDisplayScopePending(): boolean {
    return !this.getCurrentUser()?.id && (this.cookieIdentity === "pending" || this.isSignedIn());
  }

  isVerified(): boolean {
    return this.transport.hasSessionCredential() && !!this.getCurrentUser()?.emailVerified;
  }

  /** Null while a replacement credential still awaits its matching user. */
  getVerifiedSessionIdentity(): object | null {
    return this.isVerified() && this.getConfirmedDisplayUser() ? this.verifiedSessionIdentity : null;
  }

  getConfirmedDisplayUser(): AuthUser | null {
    return !this.socketUnverifiedUser && this.sessionTransitions === 0 && this.verifiedSessionIdentity !== null
      && this.verifiedSessionCredential === this.transport.getSessionToken()
      ? this.currentUser : null;
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
    const user = this.getCurrentUser();
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

  private setCurrentUser(user: AuthUser | null, confirmSession = true, confirmVerification = confirmSession): void {
    const sameAccount = this.currentUser?.id === user?.id;
    const previous = this.getCurrentUser();
    this.traceAuth("setCurrentUser", user);
    this.currentUser = user;
    if (confirmVerification || !sameAccount || !user) this.socketUnverifiedUser = null;
    else if (this.socketUnverifiedUser) this.socketUnverifiedUser = { ...user, emailVerified: false };
    const changed = this.socketEntitlementKey(previous) !== this.socketEntitlementKey(this.getCurrentUser());
    if (confirmSession) this.cookieIdentity = "ready";
    // Another account, or a plan that changed, reads other answers: no later read joins one sent before.
    if (changed) this.transport.forgetSharedReads();
    if (confirmSession) {
      this.clearSessionRevalidationTimer();
      this.verifiedSessionIdentity = user ? {} : null;
      this.verifiedSessionCredential = this.transport.getSessionToken();
    } else if (!sameAccount || !user) {
      this.verifiedSessionIdentity = null;
    }
    this.socket.syncAuthState({ reconnect: changed });
    this.emitCurrentUserChange();
  }

  private emitCurrentUserChange(): void {
    this.currentUserListeners.notify();
  }

  private updateCurrentUser(updater: (user: AuthUser) => AuthUser, confirmVerification = false): void {
    if (!this.currentUser) return;
    // A socket/profile update is metadata, not proof that a replacement
    // credential belongs to this user. Keep its existing binding, even null.
    this.setCurrentUser(updater(this.currentUser), false, confirmVerification);
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
    const user = this.getCurrentUser();
    return user?.emailVerified ? user : null;
  }

  signUp = (email: string, username: string, name: string, password: string) =>
    this.withSessionTransition((isCurrent) => this.auth.signUp(email, username, name, password, isCurrent));
  signIn(email: string, password: string) {
    return this.withSessionTransition((isCurrent) => this.auth.signIn(email, password, isCurrent));
  }
  signInWithGoogle(idToken: string) {
    return this.withSessionTransition((isCurrent) => this.auth.signInWithGoogle(idToken, isCurrent));
  }
  signOut() {
    return this.withSessionTransition((isCurrent) => this.auth.signOut(isCurrent), false);
  }

  /** Cookies can change before an auth response's body arrives, including ones the browser hides. */
  private withSessionTransition<T>(run: (isCurrent: () => boolean) => Promise<T>, reconcileFailure = true): Promise<T> {
    const previous = this.sessionTransition;
    this.cancelSessionRevalidation();
    let revalidationGeneration = this.sessionRevalidationGeneration;
    const generation = this.sessionInstallationGeneration;
    const isCurrent = () => generation === this.sessionInstallationGeneration;
    this.sessionTransitions += 1;
    this.sessionChecked = false;
    this.verifiedSessionIdentity = null;
    this.sessionRequestGeneration += 1;
    this.emitCurrentUserChange();
    let needsRevalidation = false;
    const operation = (async () => {
      // Serialize credential-changing requests so a late response cannot pair
      // one account's user with another request's installed cookie.
      if (previous) await previous;
      try {
        if (!isCurrent()) throw new Error("Another sign-in replaced this request.");
        // An earlier queued sign-out may have retired retries while clearing its token.
        revalidationGeneration = this.sessionRevalidationGeneration;
        this.sessionRequestGeneration += 1;
        const result = await run(isCurrent);
        if (!isCurrent()) throw new Error("Another sign-in replaced this request.");
        return result;
      } catch (error) {
        if (isCurrent()) {
          this.verifiedSessionIdentity = null;
          this.sessionChecked = false;
        }
        if (isCurrent() && reconcileFailure && this.transport.hasSessionCredential()) {
          // A failed body may already have changed the cookie. A fresh session
          // check is the only way to resume; retry if it cannot validate yet.
          needsRevalidation = true;
          this.sessionRequestGeneration += 1;
          await this.revalidateSession(() => isCurrent()
            && revalidationGeneration === this.sessionRevalidationGeneration).catch((failure) => {
            if (!isCurrent()) return;
            this.verifiedSessionIdentity = null;
            logFailure("cloud.auth", "Restore session after failed sign-in failed")(failure);
          });
        }
        throw error;
      } finally {
        if (isCurrent()) this.sessionRequestGeneration += 1;
        this.sessionTransitions -= 1;
        if (isCurrent() && needsRevalidation) this.scheduleSessionRevalidation(revalidationGeneration);
        this.emitCurrentUserChange();
      }
    })();
    const settled = operation.then(() => {}, () => {
      // Intentional ignore: the caller receives the error while the auth queue continues.
    });
    this.sessionTransition = settled;
    void settled.then(() => { if (this.sessionTransition === settled) this.sessionTransition = null; });
    return operation;
  }

  private clearSessionRevalidationTimer(): void {
    if (this.sessionRevalidationTimer !== null) clearTimeout(this.sessionRevalidationTimer);
    this.sessionRevalidationTimer = null;
  }

  private cancelSessionRevalidation(): void {
    this.sessionRevalidationGeneration += 1;
    this.clearSessionRevalidationTimer();
  }

  /** Revalidate after an inconclusive auth response or browser boot. */
  private scheduleSessionRevalidation(generation: number, delay = SESSION_REVALIDATION_INITIAL_MS): void {
    const isCurrent = () => generation === this.sessionRevalidationGeneration;
    const needsRevalidation = () => isCurrent() && this.sessionTransitions === 0
      && !this.sessionChecked && this.verifiedSessionIdentity === null && this.transport.hasSessionCredential();
    if (!needsRevalidation() || this.sessionRevalidationTimer !== null) return;
    this.sessionRevalidationTimer = setTimeout(() => {
      this.sessionRevalidationTimer = null;
      if (!needsRevalidation()) return;
      void this.revalidateSession(isCurrent).catch((error) => {
        if (isCurrent()) logFailure("cloud.auth", "Retry session validation failed")(error);
      }).finally(() => {
        this.scheduleSessionRevalidation(generation, Math.min(delay * 2, SESSION_REVALIDATION_MAX_MS));
      });
    }, delay);
    this.sessionRevalidationTimer.unref?.();
  }

  private async revalidateSession(isCurrent: () => boolean): Promise<void> {
    const user = await this.getSession(isCurrent);
    const credential = this.getSessionToken();
    if (user || !credential || !isCurrent()) return;
    // A native null-session response can retain a usable token. Validate it
    // through the account endpoint, without pairing it with a cached user.
    this.sessionChecked = false;
    const previousUser = this.currentUser;
    const canApply = () => isCurrent() && this.getSessionToken() === credential && this.currentUser === previousUser;
    try {
      const profile = await this.auth.getAccountProfile(canApply);
      if (!canApply()) return;
      this.sessionChecked = true;
      this.auth.restoreCachedUser({ ...profile, updatedAt: profile.updatedAt ?? undefined });
    } catch (error) {
      if (!canApply()) return;
      if (error instanceof ApiRequestError && error.status === 401) {
        this.installSessionToken(null);
        return;
      }
      throw error;
    }
  }

  /**
   * What a session check made within `maxAgeMs` found for the credential in
   * place, or undefined when none did and the server has to be asked. Lets a
   * view that opens right after the app checked its session use that answer.
   */
  recentSession(maxAgeMs: number): { user: AuthUser | null } | undefined {
    if (!this.sessionChecked || this.sessionCheckedAt === null || this.sessionTransitions > 0 || this.sessionRequest || this.socketUnverifiedUser) return undefined;
    if (Date.now() - this.sessionCheckedAt > maxAgeMs) return undefined;
    return { user: this.currentUser };
  }

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
          if (validated && canApply()) {
            this.sessionChecked = true;
            this.sessionCheckedAt = Date.now();
            this.clearSessionRevalidationTimer();
            if (this.cookieIdentity !== "ready") {
              this.cookieIdentity = "ready";
              this.emitCurrentUserChange();
            }
          }
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

  /**
   * Creates a Stripe checkout session for Cloud Pro. `link` is a short link to
   * the same checkout, to read or scan on another device, and the page the
   * browser opens: it leads through the server, which sees what the browser
   * carries (an invite link it opened). `url` is Stripe's page, which older
   * servers send alone. `lang` is the app's language, for the text the server
   * adds to the checkout page.
   */
  async createCloudCheckout(returnTo?: string, interval: "month" | "year" = "month"): Promise<{ url: string; link?: string }> {
    return this.request<{ url: string; link?: string }>("/stripe/checkout", {
      method: "POST",
      body: JSON.stringify({ returnTo, interval, lang: getLanguage() }),
    });
  }

  async recordResearchActivity(payload: {
    event: import("./research-activity").ResearchActivity; eventId: string;
    surface: "web" | "desktop" | "tui" | "cli"; anonymousId?: string;
    attribution?: Record<string, string>; feature?: import("./research-activity").ResearchFeature;
    tab?: string; desks?: readonly string[]; placement?: string; teaser_kind?: "summary" | "sample" | "none";
    cta?: "login" | "signup"; reason?: string;
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

  /**
   * A broker connection held by the Cloud account, under `/brokers/{broker}`.
   * Broker plugins reach it through `gloomberb/broker`, so the path is confined
   * to that prefix rather than the whole API.
   */
  async brokerRequest<T>(
    broker: string,
    path: string,
    options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(broker)) throw new Error(`Invalid broker id "${broker}".`);
    if (path !== "" && (!/^\/[A-Za-z0-9/_.~%?=&-]*$/.test(path) || path.includes(".."))) {
      throw new Error(`Invalid broker path "${path}".`);
    }
    return this.request<T>(`/brokers/${broker}${path}`, {
      method: options.method ?? "GET",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Stripe billing portal for an account that already has a subscription. */
  async createBillingPortal(): Promise<{ url: string }> {
    return this.request<{ url: string }>("/stripe/portal", { method: "POST", body: JSON.stringify({}) });
  }

  async createInvoicePayment(): Promise<{ url: string }> {
    const result = await this.request<{ url: string }>("/stripe/pay-invoice", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const url = new URL(result.url);
    if (url.origin !== "https://invoice.stripe.com" || url.username || url.password) {
      throw new Error("Could not open invoice payment.");
    }
    return { url: url.href };
  }

  /** Whether this account's monthly Pro can move to yearly billing; reads only. */
  async getCloudYearlyPlan(): Promise<CloudYearlyPlanStatus> {
    return readYearlyPlanStatus(await this.request<unknown>("/stripe/subscription/yearly", { method: "GET" }));
  }

  /** The exact charge of switching to yearly now. Charges nothing. */
  async previewCloudYearlyPlan(): Promise<CloudYearlyReview> {
    const body = await this.request<{ review?: unknown }>("/stripe/subscription/yearly/preview", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const review = readYearlyReview(body?.review);
    if (!review) throw new Error("Couldn't work out the yearly total. Try again in a minute.");
    return review;
  }

  /**
   * Switches to yearly billing for exactly what `token`'s review showed. Call it
   * only after the person confirmed that review. Refusals (a total that moved,
   * a switch already going through) are ApiRequestErrors; `yearlyRefusalCode`
   * names them.
   */
  async confirmCloudYearlyPlan(token: string): Promise<CloudYearlyResult> {
    const body = await this.request<unknown>("/stripe/subscription/yearly/confirm", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    const result = readYearlyResult(body);
    if (!result) throw new Error("We couldn't confirm the switch. Refresh your account before trying again.");
    return result;
  }

  /**
   * Ends the Pro trial and Pro now, unbilled. Call it only once the person
   * confirmed a warning that says so. `endedNow` is false when the server
   * scheduled the cancel at the period end instead: the subscription was no
   * longer in its trial, or the server predates ending a trial early. The
   * reason and note, when given, go to the billing provider with the cancel.
   */
  async endCloudTrial(feedback: CloudCancelFeedback = {}): Promise<{ canceled: boolean; endedNow?: boolean }> {
    return this.request<{ canceled: boolean; endedNow?: boolean }>("/stripe/subscription/cancel", {
      method: "POST",
      body: JSON.stringify({ ...cancelFeedbackBody(feedback), endTrialNow: true }),
    });
  }

  /**
   * Stops a paid Pro plan from renewing: it keeps Pro to the end of the period
   * it paid for. The same request gloom.sh's cancel window sends, the reason
   * and note with it when given. Call it only once the person confirmed.
   */
  async cancelCloudSubscription(feedback: CloudCancelFeedback = {}): Promise<{ canceled: boolean; endedNow?: boolean }> {
    return this.request<{ canceled: boolean; endedNow?: boolean }>("/stripe/subscription/cancel", {
      method: "POST",
      body: JSON.stringify(cancelFeedbackBody(feedback)),
    });
  }

  /**
   * The save offer and the kept price the cancel flow shows, read as it opens.
   * The server counts this as the cancel flow starting.
   */
  async getCloudRetentionOffer(options?: { signal?: AbortSignal }): Promise<CloudRetentionOfferAnswer> {
    const body = await this.request<Partial<CloudRetentionOfferAnswer> | null>("/stripe/subscription/retention-offer", {
      method: "GET",
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const kept = body?.keptPrice;
    return {
      ...parseRetentionOfferBase(body),
      keptPrice: kept && Number.isFinite(kept.amount) && Number.isFinite(kept.listAmount)
        && (kept.interval === "month" || kept.interval === "year")
        ? { amount: kept.amount, listAmount: kept.listAmount, interval: kept.interval }
        : null,
    };
  }

  /** Takes the save offer the cancel flow showed, with the reason and note picked. */
  async acceptCloudRetentionOffer(feedback: CloudCancelFeedback = {}): Promise<{ offer: CloudRetentionOffer | null; extendedTrialEndsAt: string | null }> {
    const body = await this.request<{ offer?: unknown; extendedTrialEndsAt?: unknown } | null>("/stripe/subscription/retention-offer", {
      method: "POST",
      body: JSON.stringify(cancelFeedbackBody(feedback)),
    });
    return parseRetentionOfferBase(body);
  }

  /**
   * Asks which arm of an app experiment this account or web visitor is in, at the
   * moment it would show. The API counts the answer as the exposure.
   */
  async recordExperimentExposure(payload: {
    eventId: string; surface: "web" | "desktop" | "tui" | "cli"; anonymousId?: string;
    attribution?: Record<string, string>; experiment: string; variant?: string;
  }, signal?: AbortSignal): Promise<import("./web-experiments").ExperimentAnswer> {
    return this.request("/activity/research", {
      method: "POST",
      body: JSON.stringify({ event: "experiment_exposed", ...payload }),
      ...(signal ? { signal } : {}),
    });
  }

  async getSyncSnapshot(): Promise<CloudSyncSnapshotResponse> {
    return this.request<CloudSyncSnapshotResponse>("/sync/snapshot", { method: "GET" });
  }

  /**
   * `baseRevision` goes out as If-Match: the server ignores the body field and
   * would replace a snapshot another device wrote since this one pulled. With
   * the header it refuses that write (409), raised as SyncRevisionConflictError
   * so the controller pulls again instead.
   */
  async putSyncSnapshot(snapshot: SyncSnapshot, options?: { baseRevision?: number | null }): Promise<CloudSyncPushResponse> {
    const baseRevision = options?.baseRevision ?? null;
    try {
      return await this.request<CloudSyncPushResponse>("/sync/snapshot", {
        method: "PUT",
        ...(baseRevision !== null ? { headers: { "If-Match": String(baseRevision) } } : {}),
        body: JSON.stringify({ snapshot, baseRevision }),
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) throw new SyncRevisionConflictError(error.message);
      throw error;
    }
  }

  async #fetchLayoutById<T>(id: string, query: string, parse: (raw: unknown) => T | null, options?: { signal?: AbortSignal }): Promise<T | null> {
    if (!isMarketplaceLayoutId(id)) return null;
    try {
      return parse(await this.request<unknown>(`/layouts/${encodeURIComponent(id)}${query}`, { method: "GET", signal: options?.signal }));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  getMarketplaceLayout(id: string, options?: { signal?: AbortSignal }): Promise<LayoutMarketplaceEntry | null> {
    return this.#fetchLayoutById(id, "", parseMarketplaceLayoutEntry, options);
  }

  async listMarketplaceLayouts(options?: { signal?: AbortSignal }): Promise<LayoutMarketplaceEntry[]> {
    return requireLayoutData(
      parseMarketplaceLayoutList(await this.request<unknown>("/layouts", { method: "GET", signal: options?.signal })),
      "The layout marketplace returned invalid data.",
    );
  }

  async publishMarketplaceLayout(name: string, payload: LayoutMarketplacePayload, options?: { signal?: AbortSignal }): Promise<LayoutMarketplaceEntry> {
    return requireLayoutData(
      parseMarketplaceLayoutEntry(await this.request<unknown>("/layouts", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), ...payload }),
        signal: options?.signal,
      })),
      "The layout marketplace returned invalid data.",
    );
  }

  // Cloud layouts: the full, revisioned shape behind ?v=2 and the new routes.

  getCloudLayout(id: string, options?: { signal?: AbortSignal }): Promise<CloudLayoutEntry | null> {
    return this.#fetchLayoutById(id, "?v=2", parseCloudLayoutEntry, options);
  }

  async listTeamLayouts(teamId: string, options?: { signal?: AbortSignal }): Promise<CloudLayoutEntry[]> {
    return requireLayoutData(
      parseCloudLayoutList(await this.request<unknown>(`/teams/${encodeURIComponent(teamId)}/layouts`, { method: "GET", signal: options?.signal })),
      "The layout service returned invalid data.",
    );
  }

  async publishTeamLayout(
    teamId: string,
    name: string,
    payload: LayoutMarketplacePayload,
    options: { requires?: LayoutRequirement[]; note?: string | null; visibility?: "team" | "public" } = {},
  ): Promise<CloudLayoutEntry> {
    return requireLayoutData(
      parseCloudLayoutEntry(await this.request<unknown>(`/teams/${encodeURIComponent(teamId)}/layouts`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...payload,
          requires: options.requires ?? [],
          ...(options.note ? { note: options.note } : {}),
          ...(options.visibility ? { visibility: options.visibility } : {}),
        }),
      })),
      "The layout service returned invalid data.",
    );
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
    return requireLayoutData(
      parseCloudLayoutEntry(await putWithRevision<unknown, CloudLayoutEntry>(
        (path, init) => this.request(path, init),
        `/layouts/${encodeURIComponent(id)}`,
        {
          ...payload,
          requires: options.requires ?? [],
          ...(options.note ? { note: options.note } : {}),
          ...(options.name ? { name: options.name } : {}),
        },
        {
          expected: options.expectedRevision,
          loadCurrent: () => this.getCloudLayout(id),
          conflict: LayoutRevisionConflictError,
        },
      )),
      "The layout service returned invalid data.",
    );
  }

  /**
   * Resolves a natural-language command-bar query into runnable command-bar
   * inputs. Requires a verified session; free accounts are included. The
   * request is bounded client-side so a stalled upstream cannot hold the
   * command bar in its loading state. The server keeps the query and answers
   * with a `searchId` unless told `log: false`, so an opt-out has to be sent
   * explicitly.
   */
  async assistCommand(
    query: string,
    commands: AssistCommandDescriptor[],
    options?: { signal?: AbortSignal; log?: boolean },
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
          commands: commands.slice(0, ASSIST_COMMAND_LIMIT).map(capAssistArgOptions),
          ...(options?.log !== undefined ? { log: options.log } : {}),
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

  /**
   * Stores how a command-bar search ended, to improve search. Fire and
   * forget: sent only with a signed-in session, it never throws and never
   * waits, and a report that fails is dropped.
   */
  reportCommandSearch(report: CommandSearchReport): void {
    try {
      if (!this.isSignedIn()) return;
      void this.telemetry.reportCommandSearch(report).catch(logFailure("cloud-telemetry", "Command search report failed"));
    } catch (error) {
      logFailure("cloud-telemetry", "Command search reporting failed")(error);
      /* A report must never get in the way of the command bar. */
    }
  }

  dispose(): void {
    this.cancelSessionRevalidation();
    this.sessionInstallationGeneration += 1;
    this.sessionRequestGeneration += 1;
    this.sessionRequest = null;
    this.socket.dispose();
    this.transport.dispose();
  }

  static {
    const proto = GloomApiClient.prototype as unknown as Record<string, unknown>;
    const bind = (get: (client: GloomApiClient) => object, targetKey: string, sourceKey: string) => {
      if (targetKey in proto) return;
      proto[targetKey] = function (this: GloomApiClient, ...args: unknown[]) {
        return (get(this) as Record<string, (...a: unknown[]) => unknown>)[sourceKey]!(...args);
      };
    };
    const forward = (get: (client: GloomApiClient) => object, ctor: { prototype: object }) => {
      const sourceProto = ctor.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(sourceProto)) {
        if (key !== "constructor" && typeof sourceProto[key] === "function") bind(get, key, key);
      }
    };
    const forwardMap = (get: (client: GloomApiClient) => object, aliases: Record<string, string>) => {
      for (const [targetKey, sourceKey] of Object.entries(aliases)) bind(get, targetKey, sourceKey);
    };
    forward((c) => c.auth, CloudAuthApi);
    forward((c) => c.data, CloudDataApi);
    forward((c) => c.teams, CloudTeamsApi);
    forward((c) => c.theses, CloudThesesApi);
    forward((c) => c.collections, CloudCollectionsApi);
    forward((c) => c.views, CloudViewsApi);
    forward((c) => c.feedback, CloudFeedbackApi);
    forward((c) => c.roadmap, CloudRoadmapApi);
    forward((c) => c.waitlist, CloudWaitlistApi);
    forward((c) => c.heardFrom, CloudHeardFromApi);
    forward((c) => c.telemetry, CloudTelemetryApi);
    forwardMap((c) => c.chat, CHAT_METHOD_MAP);
    forwardMap((c) => c.socket, SOCKET_METHOD_MAP);
    forwardMap((c) => c.notes, NOTES_METHOD_MAP);
  }
}

export const apiClient = new GloomApiClient();
