import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiClient, type AuthUser, type ChatStateResponse } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../../test-support/plugin-persistence";
import { ChatController } from "./index";

const original = {
  getSession: apiClient.getSession,
  connectChannel: apiClient.connectChannel,
  getMessages: apiClient.getMessages,
  getAccountProfile: apiClient.getAccountProfile,
  getChatState: apiClient.getChatState,
  subscribeChatNotifications: apiClient.subscribeChatNotifications,
  subscribeChatPresence: apiClient.subscribeChatPresence,
};
const currentUser = { id: "current-user", username: "Current", emailVerified: true, plan: "pro" as const };
const cachedUser = { id: "cached-user", username: "Cached", emailVerified: false, plan: "free" as const };
const emptyState: ChatStateResponse = { channels: [], channelStates: [], notifications: [], onlineCount: 0 };
let controller: ChatController;
let persistence: MemoryPluginPersistence;
let profileRequests: number;
let activeSubscriptions: number;
let activeConnections: number;

function apiUser(user = currentUser): AuthUser {
  return { ...user, name: user.username, email: "controlled@example.invalid", image: null, createdAt: "", updatedAt: "" };
}
function attach(verified = false) {
  persistence.setState("session", { sessionToken: "controlled-token", user: { ...cachedUser, emailVerified: verified } }, { schemaVersion: 1 });
  controller.attachPersistence(persistence);
}
function runtimeStopped() {
  const runtime = (controller as any).realtime;
  expect([runtime.sessionRetryTimer, runtime.verificationPollTimer, runtime.safetyRefreshTimer]).toEqual([null, null, null]);
  expect(activeSubscriptions).toBe(0);
  expect(activeConnections).toBe(0);
}
function persistentSession() { return persistence.getState("session", { schemaVersion: 1 }); }
beforeEach(() => {
  apiClient.dispose();
  apiClient.setSessionToken(null);
  apiClient.setCookieSessionMode(false);
  controller = new ChatController();
  persistence = new MemoryPluginPersistence();
  profileRequests = 0;
  activeSubscriptions = 0;
  activeConnections = 0;
  apiClient.getMessages = async () => [];
  apiClient.connectChannel = () => {
    activeConnections += 1;
    return { send: async () => { throw new Error("Unexpected controlled send"); }, close: () => { activeConnections -= 1; } };
  };
  apiClient.getAccountProfile = async () => { profileRequests += 1; throw new ApiRequestError("Controlled outage", 503); };
  apiClient.getChatState = async () => emptyState;
  const subscribe = () => {
    activeSubscriptions += 1;
    return () => { activeSubscriptions -= 1; };
  };
  apiClient.subscribeChatNotifications = subscribe;
  apiClient.subscribeChatPresence = subscribe;
});
afterEach(() => {
  controller.dispose();
  apiClient.dispose();
  apiClient.setSessionToken(null);
  Object.assign(apiClient, original);
});

test.each(["null", "success", "reject"])("disposed get-session continuation cannot mutate account or restart runtime: %s", async (outcome) => {
  attach();
  const deferred = Promise.withResolvers<AuthUser | null>();
  apiClient.getSession = () => deferred.promise;
  const pending = controller.refreshSession();
  const completion = pending.catch((error) => error);
  controller.dispose();
  apiClient.restoreCachedUser(currentUser);
  const stored = persistentSession();
  if (outcome === "reject") deferred.reject(new Error("Controlled outage"));
  else deferred.resolve(outcome === "null" ? null : apiUser());
  const result = await completion;
  if (outcome === "reject") expect(result).toBeInstanceOf(Error);
  expect(apiClient.getCurrentUser()).toMatchObject(currentUser);
  expect(persistentSession()).toBe(stored);
  expect(profileRequests).toBe(0);
  runtimeStopped();
});

for (const outcome of ["success", 401, 403, 503] as const) test(`disposed profile validation cannot replace account or rearm polling: ${outcome}`, async () => {
  attach();
  const started = Promise.withResolvers<void>();
  const deferred = Promise.withResolvers<Awaited<ReturnType<typeof apiClient.getAccountProfile>>>();
  apiClient.getSession = async () => null;
  apiClient.getAccountProfile = () => { started.resolve(); return deferred.promise; };
  const pending = controller.refreshSession();
  await started.promise;
  controller.dispose();
  apiClient.restoreCachedUser(currentUser);
  const stored = persistentSession();
  if (outcome === "success") deferred.resolve({
    ...apiUser(), plan: "pro", company: null, title: null, bio: null, profilePublic: false,
    publicEmail: null, xAccount: null, sharedPortfolioId: null, acceptUnknownDms: false,
    chatEmailNotificationsEnabled: true, syncEnabled: true, weeklyRoundupEnabled: true,
    positionAlertsEnabled: true, lastSyncAt: null, lastRoundupEmailAt: null,
  });
  else deferred.reject(new ApiRequestError("Controlled validation failure", outcome));
  await pending;
  expect(apiClient.getSessionToken()).toBe("controlled-token");
  expect(apiClient.getCurrentUser()).toMatchObject(currentUser);
  expect(persistentSession()).toBe(stored);
  runtimeStopped();
});

for (const fallback of [false, true]) test.each(["success", "reject"])(`disposed ${fallback ? "fallback" : "verified"} chat-state refresh cannot apply private rows or restart runtime: %s`, async (outcome) => {
  attach(true);
  const started = Promise.withResolvers<void>();
  const deferred = Promise.withResolvers<ChatStateResponse>();
  apiClient.getSession = async () => fallback ? null : apiUser();
  apiClient.getChatState = () => { started.resolve(); return deferred.promise; };
  const pending = controller.refreshSession();
  await started.promise;
  controller.dispose();
  const stored = persistentSession();
  if (outcome === "reject") deferred.reject(new ApiRequestError("Controlled outage", 503));
  else deferred.resolve({ ...emptyState, channels: [{ id: "dm:retired", name: "Retired private channel", kind: "direct", created_at: "2026-09-11T00:00:00Z" }] });
  await pending;
  expect(controller.getChannels().some(channel => channel.id === "dm:retired")).toBe(false);
  expect(persistentSession()).toBe(stored);
  runtimeStopped();
});

test("controller reuse starts a new refresh and an older finally cannot clear its single-flight promise", async () => {
  attach();
  const oldRequest = Promise.withResolvers<AuthUser | null>();
  const newRequest = Promise.withResolvers<AuthUser | null>();
  let requests = 0;
  apiClient.getSession = () => ++requests === 1 ? oldRequest.promise : newRequest.promise;
  const oldRefresh = controller.refreshSession();
  controller.dispose();
  const newRefresh = controller.refreshSession();
  expect(requests).toBe(2);
  oldRequest.resolve(null);
  await oldRefresh;
  const joined = controller.refreshSession();
  expect(requests).toBe(2);
  expect(profileRequests).toBe(0);
  newRequest.resolve(apiUser());
  await Promise.all([newRefresh, joined]);
  expect(controller.getSnapshot().user).toMatchObject(currentUser);
  expect(persistentSession()).toMatchObject({ user: currentUser });
  expect(activeSubscriptions).toBe(2);
});

test("adopting a replacement account invalidates the pending session even when its token is unchanged", async () => {
  attach();
  const oldRequest = Promise.withResolvers<AuthUser | null>();
  apiClient.getSession = () => oldRequest.promise;
  const pending = controller.refreshSession();
  controller.adoptSession("controlled-token", currentUser);
  const stored = persistentSession();
  oldRequest.resolve(null);
  await pending;
  expect(apiClient.getCurrentUser()).toMatchObject(currentUser);
  expect(controller.getSnapshot().user).toMatchObject(currentUser);
  expect(persistentSession()).toBe(stored);
  expect(profileRequests).toBe(0);
  apiClient.getSession = async () => apiUser();
  await controller.refreshSession();
  expect(activeSubscriptions).toBe(2);
});

test.each(["clear", "reset"])("pending session cannot undo explicit controller %s", async (operation) => {
  attach();
  const deferred = Promise.withResolvers<AuthUser | null>();
  apiClient.getSession = () => deferred.promise;
  const pending = controller.refreshSession();
  if (operation === "clear") controller.clearSession();
  else controller.reset(true);
  const stored = persistentSession();
  deferred.resolve(apiUser());
  await pending;
  expect(controller.getSnapshot().user).toBeNull();
  expect(persistentSession()).toBe(stored);
  runtimeStopped();
});
