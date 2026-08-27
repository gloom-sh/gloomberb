import { apiClient } from "../../../../api-client";
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
  refreshChatState: () => Promise<void>;
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
  session,
  stopRealtimeSubscriptions,
  stopSafetyRefresh,
  stopVerificationPolling,
  syncVerificationPolling,
}: RefreshChatControllerSessionOptions): Promise<void> {
  session.sessionToken = apiClient.getSessionToken();
  const apiSession = await apiClient.getSession();
  if (!apiSession) {
    const persistedToken = apiClient.getSessionToken() || session.sessionToken;
    // A 200 with no user is what /auth/get-session returns when no cookie
    // reached the server. Desktop's backend process used to treat that as a
    // real sign-out and persist a wiped token, so the next launch was logged
    // out. Keep a captured native session; hard account-missing responses
    // already clear the token inside getSession().
    if (persistedToken) {
      session.sessionToken = persistedToken;
      session.user = session.user ?? normalizeSessionUser(apiClient.getCurrentUser());
      session.sessionChecked = true;
      persistSession(session.sessionToken, session.user);
      emit();
      return;
    }
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
    await refreshChatState().catch(() => {});
    ensureOpenChannelConnections();
    return;
  }

  syncVerificationPolling();
  stopSafetyRefresh();
  stopRealtimeSubscriptions();
}
