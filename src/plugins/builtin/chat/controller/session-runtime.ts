import { apiClient } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  type ChannelRuntimeState,
} from "./state";
import {
  normalizeSessionUser,
  type ChatSessionUser,
} from "./persistence";
import {
  clearSignedOutSessionChannels,
  getSessionIdentity,
  markChannelsViewedForIdentityChange,
  sessionUserFromApiSession,
} from "./session";
import type { ChatControllerStorage } from "./storage";

export interface ChatControllerSessionState {
  hydrated: boolean;
  sessionChecked: boolean;
  sessionToken: string | null;
  user: ChatSessionUser | null;
}

export function createChatControllerSessionState(): ChatControllerSessionState {
  return {
    hydrated: false,
    sessionChecked: false,
    sessionToken: null,
    user: null,
  };
}

interface HydrateChatControllerSessionOptions {
  session: ChatControllerSessionState;
  storage: ChatControllerStorage;
  syncVerificationPolling: () => void;
}

export function hydrateChatControllerSession({
  session,
  storage,
  syncVerificationPolling,
}: HydrateChatControllerSessionOptions): void {
  if (session.hydrated || !storage.hasPersistence()) return;
  session.hydrated = true;

  const storedSession = storage.readSessionState();
  const restoredUser = apiClient.getCurrentUser() ?? storedSession?.user ?? null;
  session.sessionToken = storedSession?.sessionToken ?? null;
  apiClient.setSessionToken(session.sessionToken);
  // WebSocket tokens are short-lived connection credentials. Reusing a persisted
  // one can trap reconnects on an expired token even while the session cookie is valid.
  apiClient.setWebSocketToken(null);
  apiClient.restoreCachedUser(restoredUser);
  session.user = normalizeSessionUser(restoredUser);
  session.sessionChecked = true;
  storage.ensureChannelState(DEFAULT_CHAT_CHANNEL_ID);
  syncVerificationPolling();
}

interface ApplySignedOutChatControllerSessionOptions {
  channelStates: Iterable<ChannelRuntimeState>;
  closeAllConnections: () => void;
  emit: () => void;
  persistSession: (sessionToken: string | null, user: ChatSessionUser | null) => void;
  session: ChatControllerSessionState;
  stopRealtime: () => void;
}

export function applySignedOutChatControllerSession({
  channelStates,
  closeAllConnections,
  emit,
  persistSession,
  session,
  stopRealtime,
}: ApplySignedOutChatControllerSessionOptions): void {
  stopRealtime();
  closeAllConnections();
  session.user = null;
  session.sessionChecked = true;
  clearSignedOutSessionChannels(channelStates);
  persistSession(session.sessionToken, session.user);
  emit();
}

interface RefreshChatControllerSessionOptions {
  applySignedOut: () => void;
  channelStates: Map<string, ChannelRuntimeState>;
  emit: () => void;
  ensureOpenChannelConnections: () => void;
  ensureRealtimeSubscriptions: () => void;
  persistChannelState: (channelId: string) => void;
  persistSession: (sessionToken: string | null, user: ChatSessionUser | null) => void;
  refreshChatState: (isCurrent?: () => boolean) => Promise<void>;
  scheduleSessionRetry: () => void;
  session: ChatControllerSessionState;
  stopRealtimeSubscriptions: () => void;
  stopSafetyRefresh: () => void;
  stopVerificationPolling: () => void;
  syncVerificationPolling: () => void;
}

export async function refreshChatControllerSession({
  applySignedOut,
  channelStates,
  emit,
  ensureOpenChannelConnections,
  ensureRealtimeSubscriptions,
  persistChannelState,
  persistSession,
  refreshChatState,
  scheduleSessionRetry,
  session,
  stopRealtimeSubscriptions,
  stopSafetyRefresh,
  stopVerificationPolling,
  syncVerificationPolling,
}: RefreshChatControllerSessionOptions): Promise<void> {
  session.sessionToken = apiClient.getSessionToken();
  const apiSession = await apiClient.getSession();
  if (!apiSession) {
    const persistedToken = apiClient.getSessionToken();
    // A 200 with no user used to mean the desktop backend had not received the
    // restored cookie yet, so do not discard a captured native session on that
    // response alone. Probe another authenticated endpoint: success validates
    // the token, a 401 proves it expired, and a transient failure keeps offline
    // startup from signing the user out.
    if (persistedToken) {
      session.sessionToken = persistedToken;
      session.user = session.user ?? normalizeSessionUser(apiClient.getCurrentUser());
      // getSession() clears the API client's cached user when the endpoint
      // answers null. Keep both session views aligned while the protected
      // request validates the preserved native credential.
      apiClient.restoreCachedUser(session.user);
      session.sessionChecked = true;
      persistSession(session.sessionToken, session.user);
      emit();

      const credentialIsCurrent = () =>
        apiClient.getSessionToken() === persistedToken && session.sessionToken === persistedToken;
      const handleValidationError = (error: unknown) => {
        if (!credentialIsCurrent()) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          apiClient.setSessionToken(null);
          session.sessionToken = null;
          applySignedOut();
          return;
        }
        if (error instanceof ApiRequestError && error.status === 403 && session.user) {
          session.user = { ...session.user, emailVerified: false };
          apiClient.restoreCachedUser(session.user);
          persistSession(session.sessionToken, session.user);
          emit();
          syncVerificationPolling();
          stopSafetyRefresh();
          stopRealtimeSubscriptions();
          return;
        }
        scheduleSessionRetry();
      };

      if (!session.user?.emailVerified) {
        try {
          const profile = await apiClient.getAccountProfile();
          if (!credentialIsCurrent()) return;
          const persistedProfile = {
            ...profile,
            updatedAt: profile.updatedAt ?? undefined,
          };
          session.user = normalizeSessionUser(persistedProfile);
          apiClient.restoreCachedUser(persistedProfile);
          persistSession(session.sessionToken, session.user);
          emit();
        } catch (error) {
          handleValidationError(error);
          return;
        }

        if (!session.user?.emailVerified) {
          syncVerificationPolling();
          stopSafetyRefresh();
          stopRealtimeSubscriptions();
          return;
        }
      }

      try {
        await refreshChatState(credentialIsCurrent);
      } catch (error) {
        handleValidationError(error);
        return;
      }
      if (!credentialIsCurrent()) return;

      stopVerificationPolling();
      ensureRealtimeSubscriptions();
      ensureOpenChannelConnections();
      return;
    }
    session.sessionToken = null;
    applySignedOut();
    return;
  }

  const previousIdentity = getSessionIdentity(session.user);
  const nextUser = sessionUserFromApiSession(apiSession);
  session.sessionToken = apiClient.getSessionToken();
  session.user = nextUser;
  const nextIdentity = getSessionIdentity(nextUser);
  if (previousIdentity && previousIdentity !== nextIdentity) {
    markChannelsViewedForIdentityChange(channelStates, persistChannelState);
  }
  session.sessionChecked = true;
  persistSession(session.sessionToken, session.user);
  emit();

  if (nextUser?.emailVerified) {
    stopVerificationPolling();
    ensureRealtimeSubscriptions();
    await refreshChatState().catch(() => scheduleSessionRetry());
    ensureOpenChannelConnections();
    return;
  }

  syncVerificationPolling();
  stopSafetyRefresh();
  stopRealtimeSubscriptions();
}
