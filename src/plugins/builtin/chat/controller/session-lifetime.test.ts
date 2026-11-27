import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiClient, type AuthUser, type ChatStateResponse } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../../test-support/plugin-persistence";
import { ChatController } from "./index";
import { composerStateKey } from "./state";

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
function createResumeState() {
  return Object.assign(new MemoryPluginPersistence(), {
    getPaneState: () => null,
    setPaneState: () => {},
    deletePaneState: () => {},
  });
}
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

test("a browser cannot restore an old chat identity without the matching cookie binding", () => {
  apiClient.setCookieSessionMode(true);
  apiClient.waitForCookieIdentity();
  persistence.setState("session", { sessionToken: "saved-session", user: currentUser }, { schemaVersion: 1 });
  persistence.setState(composerStateKey(currentUser.id, "everyone"), {
    draft: "saved draft", draftClientMessageId: "saved-id", replyToId: "saved-reply",
  }, { schemaVersion: 1 });
  controller.attachPersistence(persistence);
  expect(apiClient.getSessionToken()).toBeNull();
  expect(apiClient.getCurrentUser()).toBeNull();
  expect(apiClient.isDisplayScopePending()).toBe(true);
  expect(controller.getSnapshot()).toMatchObject({ user: null, composerScope: null, draft: "", replyToId: null });
});

test("keeps an installed credential while its account is being resolved", () => {
  apiClient.setSessionToken("command-session");
  attach();
  expect(apiClient.getSessionToken()).toBe("command-session");
  expect(controller.getSnapshot()).toMatchObject({ user: null, composerScope: null, draft: "" });
});

test("recovers the installed account's draft when the saved session differs", () => {
  apiClient.setSessionToken("current-session");
  apiClient.restoreCachedUser(currentUser);
  const resume = createResumeState();
  resume.setState("session", { sessionToken: "stored-session", user: cachedUser }, { schemaVersion: 1 });
  for (const user of [cachedUser, currentUser]) {
    persistence.setState(composerStateKey(user.id, "everyone"), {
      draft: `${user.username} draft`, draftClientMessageId: user.id, replyToId: `${user.id}-reply`,
    }, { schemaVersion: 1 });
  }
  controller.attachPersistence(persistence, resume);
  expect(apiClient.getSessionToken()).toBe("current-session");
  expect(apiClient.getConfirmedDisplayUser()).toMatchObject(currentUser);
  expect(controller.getSnapshot()).toMatchObject({ user: currentUser, draft: "Current draft", replyToId: "current-user-reply" });
});

test.each(["sign-out", "clear", "reset"])("a fresh controller starts signed out after %s", (operation) => {
  const resume = createResumeState();
  controller = new ChatController({ bindComposerToApiSession: true });
  controller.attachPersistence(persistence, resume);
  controller.adoptSession("current-session", currentUser);
  controller.setDraft("saved draft");
  controller.setReplyToId("saved-reply");

  if (operation === "sign-out") apiClient.setSessionToken(null);
  else if (operation === "clear") controller.clearSession();
  else controller.reset(true);

  expect(persistence.getState("session", { schemaVersion: 1 })).toBeNull();
  expect(resume.getState("session", { schemaVersion: 1 })).toBeNull();
  controller.dispose();
  controller = new ChatController({ bindComposerToApiSession: true });
  controller.attachPersistence(persistence, resume);
  expect(apiClient.getSessionToken()).toBeNull();
  expect(controller.getSnapshot()).toMatchObject({ user: null, composerScope: null, draft: "", replyToId: null });
  if (operation !== "reset") {
    controller.adoptSession("current-session-again", currentUser);
    expect(controller.getSnapshot()).toMatchObject({ draft: "saved draft", replyToId: "saved-reply" });
  }
});

test("a pending credential change does not replace the saved session binding", async () => {
  const resume = createResumeState();
  controller = new ChatController({ bindComposerToApiSession: true });
  controller.attachPersistence(persistence, resume);
  controller.adoptSession("current-session", currentUser);
  controller.setDraft("saved draft");
  controller.setReplyToId("saved-reply");
  apiClient.setSessionToken("pending-session");
  apiClient.getSession = async () => apiClient.getCurrentUser();
  await controller.refreshSession();

  for (const store of [persistence, resume]) {
    expect(store.getState("session", { schemaVersion: 1 })).toMatchObject({ sessionToken: "current-session", user: currentUser });
  }
  controller.dispose();
  controller = new ChatController({ bindComposerToApiSession: true });
  controller.attachPersistence(persistence, resume);
  expect(apiClient.getSessionToken()).toBe("pending-session");
  expect(controller.getSnapshot()).toMatchObject({ composerScope: null, draft: "", replyToId: null });
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
