import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport, type AuthUser } from "../api-client";
import { installTestWebSocket } from "../test-support/cloud-api";
import { ChatController } from "../plugins/builtin/chat/controller";
import { performEmailAuth } from "../account/auth-model";
import { accountSession, registerAccountSession } from "../account/session";
import type { AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { subscribeToCloudVerification } from "./auth-transition";
import { CloudSyncController } from "./controller";
import type { SyncSnapshot, SyncTransport } from "./types";

const accountA: AuthUser = { id: "account-a", username: "account-a", name: "Account A", email: "a@example.invalid", emailVerified: true, image: null, createdAt: "", updatedAt: "" };
const accountB: AuthUser = { ...accountA, id: "account-b" };
const cleanups: Array<() => void> = [];
const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  apiClient.dispose();
  apiClient.setSessionToken(null);
  apiClient.setCookieSessionMode(false);
  setCloudApiFetchTransport(null);
  globalThis.WebSocket = originalWebSocket;
});

function sessionHarness(browser: boolean) {
  apiClient.setCookieSessionMode(browser);
  if (!browser) apiClient.setSessionToken("token-a");
  apiClient.restoreCachedUser(accountA);
  let local: unknown = { account: "a" };
  let baseline: Record<string, unknown> | null = null;
  let memos: Record<string, unknown> | null = null;
  let collect: (() => Promise<unknown>) | undefined;
  const transport: SyncTransport = {
    id: "gloomberb-cloud",
    isAvailable: () => apiClient.getVerifiedSessionIdentity() !== null,
    pullSnapshot: () => apiClient.getSyncSnapshot(),
    pushSnapshot: (snapshot, options) => apiClient.putSyncSnapshot(snapshot, options),
  };
  const controller = new CloudSyncController();
  controller.setRuntime({
    getState: () => ({} as AppState), dispatch: () => {}, tickerRepository: {} as AppTickerRepositoryPort,
    getSessionIdentity: () => apiClient.getVerifiedSessionIdentity(),
    getTransport: () => ({ pluginId: "test", transport }),
    getContributors: () => [{ pluginId: "test", contributor: {
      id: "test.data", schemaVersion: 1,
      collect: () => collect ? collect() : local,
      apply: (payload, context) => { local = payload; context.memo!.set(payload); },
    } }],
    baselineStore: {
      load: () => baseline, save: (value) => { baseline = value; },
      loadMemos: () => memos, saveMemos: (value) => { memos = value; },
    },
  });
  let ready = Promise.resolve();
  cleanups.push(subscribeToCloudVerification(apiClient,
    () => { ready = controller.requestSync({ reason: "session-verified" }); },
    () => controller.resetAccount()));
  cleanups.push(() => controller.clearRuntime());
  return { controller, ready: () => ready, baseline: () => baseline, memos: () => memos,
    holdCollect: (next: () => Promise<unknown>) => { collect = next; },
    releaseCollect: () => { collect = undefined; }, local: () => local };
}

function snapshot(account: string): SyncSnapshot {
  return { appId: "gloomberb", schemaVersion: 1, clientId: `device-${account}`, createdAt: "2026-10-25T00:00:00.000Z",
    contributors: { "test.data": { schemaVersion: 1, updatedAt: "2026-10-25T00:00:00.000Z", payload: { account } } } };
}

test.each([["native", false], ["browser", true]] as const)("a sign-in's new credential cannot receive the old account's pending sync (%s)", async (_surface, browser) => {
  let cloud = "a";
  const readingBody = Promise.withResolvers<void>();
  const authBody = Promise.withResolvers<string>();
  const collecting = Promise.withResolvers<void>();
  const collected = Promise.withResolvers<unknown>();
  const pushes: Array<{ cloud: string; payload: unknown }> = [];
  setCloudApiFetchTransport(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") {
      cloud = "b";
      return { ok: true, status: 200,
        headers: new Headers(browser ? {} : { "set-cookie": "gloomberb.session_token=token-b; Path=/; HttpOnly" }),
        text: () => { readingBody.resolve(); return authBody.promise; } };
    }
    if (init?.method === "PUT") {
      pushes.push({ cloud, payload: JSON.parse(String(init.body)).snapshot.contributors["test.data"].payload });
      return Response.json({ revision: 11, updatedAt: "2026-10-25T00:00:00.000Z" });
    }
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(browser);
  await h.controller.requestSync();
  h.holdCollect(() => { collecting.resolve(); return collected.promise; });
  const oldSync = h.controller.requestSync({ force: true });
  await collecting.promise;
  const signIn = apiClient.signIn("b@example.invalid", "unused");
  await readingBody.promise;
  h.releaseCollect();
  collected.resolve({ account: "a" });
  await oldSync;
  const beforeBody = [...pushes];
  authBody.resolve(JSON.stringify({ user: accountB }));
  await signIn;
  await h.ready();

  expect(beforeBody).toEqual([]);
  expect(h.local()).toEqual({ account: "b" });
  expect(h.controller.getStatus()).toMatchObject({ phase: "synced", revision: 2 });
  expect(pushes).toEqual([]);
});

test.each(["same account", "failed sign-in", "failed validation"])("%s preserves the account's merge state", async (scenario) => {
  let sessionChecks = 0;
  let validate = scenario !== "failed validation";
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") return scenario === "same account"
      ? Response.json({ user: accountA }) : Response.json({ message: "Sign-in failed" }, { status: 401 });
    if (path === "/auth/get-session") {
      sessionChecks += 1;
      return validate ? Response.json({ user: accountA }) : Response.json({ message: "Unreachable" }, { status: 503 });
    }
    return Response.json({ snapshot: snapshot("a"), revision: 10, updatedAt: null });
  });
  const h = sessionHarness(true);
  await h.controller.requestSync();
  const baseline = h.baseline();
  const memos = h.memos();
  if (scenario === "same account") await apiClient.signIn("a@example.invalid", "unused");
  else await expect(apiClient.signIn("a@example.invalid", "unused")).rejects.toThrow("Sign-in failed");
  await h.ready();
  expect(h.baseline()).toBe(baseline);
  expect(h.memos()).toBe(memos);
  expect(h.controller.getStatus().revision).toBe(10);
  expect(sessionChecks).toBe(scenario === "same account" ? 0 : 1);
  if (scenario === "failed validation") {
    expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
    validate = true;
    await apiClient.getSession();
    await h.ready();
    expect(h.baseline()).toBe(baseline);
    expect(h.memos()).toBe(memos);
  }
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
});

test("a failed auth body revalidates the new cookie instead of reusing a pending old session check", async () => {
  const staleSession = Promise.withResolvers<string>();
  const readingOldSession = Promise.withResolvers<void>();
  let cloud = "a";
  let sessionChecks = 0;
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") {
      cloud = "b";
      return { ok: true, status: 200, headers: new Headers(), text: () => Promise.reject(new Error("Body interrupted")) };
    }
    if (path === "/auth/get-session") {
      sessionChecks += 1;
      if (sessionChecks > 1) return Response.json({ user: accountB });
      return { ok: true, status: 200, headers: new Headers(), text: () => { readingOldSession.resolve(); return staleSession.promise; } };
    }
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(true);
  await h.controller.requestSync();
  const previous = apiClient.getSession();
  await readingOldSession.promise;
  await expect(apiClient.signIn("b@example.invalid", "unused")).rejects.toThrow("Body interrupted");
  await h.ready();
  staleSession.resolve(JSON.stringify({ user: accountA }));
  await previous;

  expect(sessionChecks).toBe(2);
  expect(apiClient.getCurrentUser()?.id).toBe("account-b");
  expect(h.local()).toEqual({ account: "b" });
  expect(h.controller.getStatus()).toMatchObject({ phase: "synced", revision: 2 });
});

test("a failed browser sign-out stays signed out without restoring its cookie session", async () => {
  let sessionChecks = 0;
  setCloudApiFetchTransport(async (url) => {
    if (new URL(String(url)).pathname === "/auth/get-session") sessionChecks += 1;
    return Response.json({ message: "Sign-out failed" }, { status: 503 });
  });
  sessionHarness(true);
  await expect(apiClient.signOut()).rejects.toThrow("Sign-out failed");
  expect(apiClient.getCurrentUser()).toBeNull();
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  expect(sessionChecks).toBe(0);
});

test("a same-account credential refresh retires a pending write without resetting its merge state", async () => {
  let pushes = 0;
  setCloudApiFetchTransport(async (_url, init) => {
    if (init?.method === "PUT") pushes += 1;
    return Response.json({ snapshot: snapshot("a"), revision: 10, updatedAt: null });
  });
  const h = sessionHarness(false);
  await h.controller.requestSync();
  const baseline = h.baseline();
  const memos = h.memos();
  const collecting = Promise.withResolvers<void>();
  const collected = Promise.withResolvers<unknown>();
  h.holdCollect(() => { collecting.resolve(); return collected.promise; });
  const previous = h.controller.requestSync({ force: true });
  await collecting.promise;
  apiClient.setSessionToken("token-a-refreshed");
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  apiClient.restoreCachedUser(accountA);
  h.releaseCollect();
  collected.resolve({ account: "a" });
  await previous;
  await h.ready();

  expect(pushes).toBe(0);
  expect(h.baseline()).toBe(baseline);
  expect(h.memos()).toBe(memos);
  expect(h.controller.getStatus().revision).toBe(10);
});

test("overlapping sign-ins publish readiness only after their credential changes finish in order", async () => {
  const firstBody = Promise.withResolvers<string>();
  const secondBody = Promise.withResolvers<string>();
  const secondStarted = Promise.withResolvers<void>();
  const requested: string[] = [];
  setCloudApiFetchTransport(async (url, init) => {
    if (new URL(String(url)).pathname !== "/auth/sign-in/email") return Response.json({ snapshot: snapshot("a"), revision: 10, updatedAt: null });
    requested.push(JSON.parse(String(init?.body)).email);
    return { ok: true, status: 200, headers: new Headers(), text: () => {
      if (requested.length === 1) return firstBody.promise;
      secondStarted.resolve();
      return secondBody.promise;
    } };
  });
  const h = sessionHarness(true);
  const first = apiClient.signIn("b@example.invalid", "unused");
  const second = apiClient.signIn("a@example.invalid", "unused");
  expect(requested).toEqual(["b@example.invalid"]);
  firstBody.resolve(JSON.stringify({ user: accountB }));
  await first;
  await secondStarted.promise;
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  secondBody.resolve(JSON.stringify({ user: accountA }));
  await second;
  await h.ready();

  expect(requested).toEqual(["b@example.invalid", "a@example.invalid"]);
  expect(apiClient.getCurrentUser()?.id).toBe("account-a");
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
});

test("socket metadata cannot restore readiness after an auth body and its session validation fail", async () => {
  const sockets = installTestWebSocket();
  const readingBody = Promise.withResolvers<void>();
  const authBody = Promise.withResolvers<string>();
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") return { ok: true, status: 200,
      headers: new Headers({ "set-cookie": "gloomberb.session_token=token-b; Path=/; HttpOnly" }),
      text: () => { readingBody.resolve(); return authBody.promise; } };
    if (path === "/auth/get-session") return Response.json({ message: "Unreachable" }, { status: 503 });
    return Response.json({ snapshot: snapshot("a"), revision: 10, updatedAt: null });
  });
  const h = sessionHarness(false);
  await h.controller.requestSync();
  const baseline = h.baseline();
  cleanups.push(apiClient.subscribeQuotes([{ symbol: "AAPL", exchange: "NASDAQ" }], () => {}));
  const signIn = apiClient.signIn("b@example.invalid", "unused");
  await readingBody.promise;
  sockets.at(-1)!.receive({ type: "ready", user: { name: "Current profile" } });
  authBody.reject(new Error("Body interrupted"));
  await expect(signIn).rejects.toThrow("Body interrupted");
  sockets.at(-1)!.receive({ type: "ready", user: { name: "Later profile" } });

  expect(apiClient.getCurrentUser()).toMatchObject({ id: "account-a", name: "Later profile" });
  expect(apiClient.getSessionToken()).toBe("token-b");
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  expect(h.baseline()).toBe(baseline);
});

test("socket verification makes an established unverified session ready", () => {
  const sockets = installTestWebSocket();
  apiClient.setSessionToken("token-a");
  apiClient.restoreCachedUser({ ...accountA, emailVerified: false });
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  cleanups.push(apiClient.subscribeQuotes([{ symbol: "AAPL", exchange: "NASDAQ" }], () => {}));
  sockets.at(-1)!.receive({ type: "ready", user: { emailVerified: true } });
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
});

test("a discarded recovery read cannot revive a session validated before a failed browser sign-in", async () => {
  const sockets = installTestWebSocket();
  const authResponse = Promise.withResolvers<Response>();
  const recovering = Promise.withResolvers<void>();
  const recoveryBody = Promise.withResolvers<string>();
  let sessionReads = 0;
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") return authResponse.promise;
    if (path === "/auth/get-session") {
      if (++sessionReads === 1) return Response.json({ user: accountA });
      return { ok: true, status: 200, headers: new Headers(),
        text: () => { recovering.resolve(); return recoveryBody.promise; } };
    }
    return Response.json({ snapshot: snapshot("a"), revision: 10, updatedAt: null });
  });
  const h = sessionHarness(true);
  await h.controller.requestSync();
  const baseline = h.baseline();
  cleanups.push(apiClient.subscribeQuotes([{ symbol: "AAPL", exchange: "NASDAQ" }], () => {}));
  const signIn = apiClient.signIn("b@example.invalid", "unused");
  await apiClient.getSession();
  authResponse.resolve(Response.json({ message: "Sign-in failed" }, { status: 401 }));
  await recovering.promise;
  sockets.at(-1)!.receive({ type: "ready", user: { name: "Current profile" } });
  recoveryBody.resolve(JSON.stringify({ user: accountB }));
  await expect(signIn).rejects.toThrow("Sign-in failed");

  expect(apiClient.getCurrentUser()?.id).toBe("account-a");
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  expect(h.baseline()).toBe(baseline);
});

test("a session read started during sign-in cannot restore the previous browser account afterwards", async () => {
  const readingAuth = Promise.withResolvers<void>();
  const authBody = Promise.withResolvers<string>();
  const readingSession = Promise.withResolvers<void>();
  const sessionBody = Promise.withResolvers<string>();
  let cloud = "a";
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") return { ok: true, status: 200, headers: new Headers(),
      text: () => { readingAuth.resolve(); return authBody.promise; } };
    if (path === "/auth/get-session") return { ok: true, status: 200, headers: new Headers(),
      text: () => { readingSession.resolve(); return sessionBody.promise; } };
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(true);
  await h.controller.requestSync();
  const signIn = apiClient.signIn("b@example.invalid", "unused");
  await readingAuth.promise;
  const session = apiClient.getSession();
  await readingSession.promise;
  cloud = "b";
  authBody.resolve(JSON.stringify({ user: accountB }));
  await signIn;
  await h.ready();
  sessionBody.resolve(JSON.stringify({ user: accountA }));
  await session;

  expect(apiClient.getCurrentUser()?.id).toBe("account-b");
  expect(h.local()).toEqual({ account: "b" });
  expect(h.controller.getStatus().revision).toBe(2);
});

for (const operation of ["sign-in", "sign-up", "sign-out"] as const) {
  test.each(["success", "failure"])(`a late ${operation} %s cannot replace an adopted device session`, async (outcome) => {
    const readingBody = Promise.withResolvers<void>();
    const authBody = Promise.withResolvers<string>();
    let cloud = "a";
    let sessionChecks = 0;
    const pushes: unknown[] = [];
    setCloudApiFetchTransport(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/auth/get-session") { sessionChecks += 1; return Response.json({ user: accountA }); }
      if (path.startsWith("/auth/")) return {
        ok: outcome === "success", status: outcome === "success" ? 200 : 401,
        headers: new Headers({ "set-cookie": "gloomberb.session_token=email-token-a; Path=/; HttpOnly" }),
        text: () => { readingBody.resolve(); return authBody.promise; },
      };
      if (init?.method === "PUT") {
        pushes.push(JSON.parse(String(init.body)));
        return Response.json({ revision: 3, updatedAt: "2026-10-25T00:00:00.000Z" });
      }
      return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
    });
    const h = sessionHarness(false);
    await h.controller.requestSync();
    const chat = new ChatController();
    cleanups.push(() => chat.dispose());
    const pending = operation === "sign-in" ? apiClient.signIn("a@example.invalid", "unused")
      : operation === "sign-up" ? apiClient.signUp("a@example.invalid", "account-a", "Account A", "unused")
      : apiClient.signOut();
    await readingBody.promise;
    cloud = "b";
    chat.adoptSession("device-token-b", accountB);
    authBody.resolve(JSON.stringify(outcome === "success" ? { user: accountA } : { message: "Rejected" }));
    await expect(pending).rejects.toThrow();
    await h.ready();

    expect(apiClient.getCurrentUser()?.id).toBe("account-b");
    expect(apiClient.getSessionToken()).toBe("device-token-b");
    expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
    expect(sessionChecks).toBe(0);
    expect(h.local()).toEqual({ account: "b" });
    expect(h.controller.getStatus().revision).toBe(2);
    expect(pushes).toEqual([]);
  });
}

test("a tolerated native null-session response preserves the same account's sync state", async () => {
  installTestWebSocket();
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/get-session") return Response.json({ user: null });
    if (path === "/chat/state") return Response.json({ channels: [], channelStates: [], notifications: [], onlineCount: 0 });
    return Response.json({ snapshot: snapshot("a"), revision: 10, updatedAt: null });
  });
  const h = sessionHarness(false);
  const chat = new ChatController();
  cleanups.push(() => chat.dispose());
  chat.adoptSession("token-a", accountA);
  await h.controller.requestSync();
  const baseline = h.baseline();
  const memos = h.memos();
  await chat.refreshSession();
  await h.ready();

  expect(apiClient.getCurrentUser()?.id).toBe("account-a");
  expect(apiClient.getSessionToken()).toBe("token-a");
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
  expect(h.baseline()).toBe(baseline);
  expect(h.memos()).toBe(memos);
  expect(h.controller.getStatus().revision).toBe(10);
});

test("a delayed verification email cannot adopt its old user with a device session's token", async () => {
  const sendingVerification = Promise.withResolvers<void>();
  const verificationResponse = Promise.withResolvers<Response>();
  let cloud = "a";
  let sessionChecks = 0;
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") return Response.json({ user: { ...accountA, emailVerified: false } });
    if (path === "/cloud/auth/send-verification") { sendingVerification.resolve(); return verificationResponse.promise; }
    if (path === "/auth/get-session") { sessionChecks += 1; return Response.json({ user: accountB }); }
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(false);
  await h.controller.requestSync();
  const chat = new ChatController();
  const previousOwner = accountSession;
  registerAccountSession(chat);
  cleanups.push(() => { registerAccountSession(previousOwner); chat.dispose(); });
  const pending = performEmailAuth("login", "a@example.invalid", "unused");
  await sendingVerification.promise;
  cloud = "b";
  chat.adoptSession("device-token-b", accountB);
  await h.ready();
  const baseline = h.baseline();
  verificationResponse.resolve(Response.json({ sent: true }));
  await expect(pending).rejects.toThrow();

  expect(apiClient.getCurrentUser()?.id).toBe("account-b");
  expect(apiClient.getSessionToken()).toBe("device-token-b");
  expect(h.local()).toEqual({ account: "b" });
  expect(h.baseline()).toBe(baseline);
  expect(sessionChecks).toBe(0);
});

test("a queued email sign-in still runs after an intentional sign-out clears the credential", async () => {
  const signOutResponse = Promise.withResolvers<Response>();
  const requested: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    requested.push(path);
    return path === "/auth/sign-out" ? signOutResponse.promise : Response.json({ user: accountB }, {
      headers: { "set-cookie": "gloomberb.session_token=token-b; Path=/; HttpOnly" },
    });
  });
  apiClient.setSessionToken("token-a");
  apiClient.restoreCachedUser(accountA);
  const signOut = apiClient.signOut();
  const signIn = apiClient.signIn("b@example.invalid", "unused");
  expect(requested).toEqual(["/auth/sign-out"]);
  signOutResponse.resolve(Response.json({}));
  await Promise.all([signOut, signIn]);

  expect(requested).toEqual(["/auth/sign-out", "/auth/sign-in/email"]);
  expect(apiClient.getCurrentUser()?.id).toBe("account-b");
  expect(apiClient.getSessionToken()).toBe("token-b");
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
});

test("native fallback validates a replacement token before restoring any cached account", async () => {
  installTestWebSocket();
  let cloud = "a";
  let profileChecks = 0;
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") {
      cloud = "b";
      return { ok: true, status: 200,
        headers: new Headers({ "set-cookie": "gloomberb.session_token=token-b; Path=/; HttpOnly" }),
        text: () => Promise.reject(new Error("Body interrupted")) };
    }
    if (path === "/auth/get-session") return Response.json({ user: null });
    if (path === "/account/profile") { profileChecks += 1; return Response.json({ profile: accountB }); }
    if (path === "/chat/state") return Response.json({ channels: [], channelStates: [], notifications: [], onlineCount: 0 });
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(false);
  const chat = new ChatController();
  cleanups.push(() => chat.dispose());
  chat.adoptSession("token-a", accountA);
  await h.controller.requestSync();
  await expect(apiClient.signIn("b@example.invalid", "unused")).rejects.toThrow("Body interrupted");
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  await chat.refreshSession();
  await h.ready();

  expect(profileChecks).toBe(1);
  expect(apiClient.getCurrentUser()?.id).toBe("account-b");
  expect(apiClient.getSessionToken()).toBe("token-b");
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
  expect(h.local()).toEqual({ account: "b" });
  expect(h.controller.getStatus().revision).toBe(2);
});

test("restoring the same native credential during a null session check does not cancel a pending login", async () => {
  installTestWebSocket();
  const signInResponse = Promise.withResolvers<Response>();
  let cloud = "a";
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") return signInResponse.promise;
    if (path === "/auth/get-session") return Response.json({ user: null });
    if (path === "/chat/state") return Response.json({ channels: [], channelStates: [], notifications: [], onlineCount: 0 });
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(false);
  const chat = new ChatController();
  cleanups.push(() => chat.dispose());
  chat.adoptSession("token-a", accountA);
  await h.controller.requestSync();
  const baseline = h.baseline();
  const memos = h.memos();
  const signIn = apiClient.signIn("b@example.invalid", "unused");
  await chat.refreshSession();
  expect(apiClient.getCurrentUser()?.id).toBe("account-a");
  expect(h.baseline()).toBe(baseline);
  expect(h.memos()).toBe(memos);
  expect(h.controller.getStatus().revision).toBe(10);
  cloud = "b";
  signInResponse.resolve(Response.json({ user: accountB }, {
    headers: { "set-cookie": "gloomberb.session_token=token-b; Path=/; HttpOnly" },
  }));
  await expect(signIn).resolves.toMatchObject({ id: "account-b" });
  await h.ready();

  expect(apiClient.getSessionToken()).toBe("token-b");
  expect(h.local()).toEqual({ account: "b" });
  expect(h.controller.getStatus().revision).toBe(2);
});

test("a failed native session refresh cannot associate its new token with the old cached user", async () => {
  installTestWebSocket();
  let cloud = "a";
  let sessionChecks = 0;
  let profileChecks = 0;
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/sign-in/email") {
      cloud = "b";
      return { ok: true, status: 200,
        headers: new Headers({ "set-cookie": "gloomberb.session_token=token-b; Path=/; HttpOnly" }),
        text: () => Promise.reject(new Error("Body interrupted")) };
    }
    if (path === "/auth/get-session") {
      sessionChecks += 1;
      return sessionChecks <= 2 ? Response.json({ message: "Unavailable" }, { status: 503 }) : Response.json({ user: null });
    }
    if (path === "/account/profile") { profileChecks += 1; return Response.json({ profile: accountB }); }
    if (path === "/chat/state") return Response.json({ channels: [], channelStates: [], notifications: [], onlineCount: 0 });
    return Response.json({ snapshot: snapshot(cloud), revision: cloud === "a" ? 10 : 2, updatedAt: null });
  });
  const h = sessionHarness(false);
  const chat = new ChatController();
  cleanups.push(() => chat.dispose());
  chat.adoptSession("token-a", accountA);
  await h.controller.requestSync();
  await expect(apiClient.signIn("b@example.invalid", "unused")).rejects.toThrow("Body interrupted");
  await expect(chat.refreshSession()).rejects.toThrow("Unavailable");
  expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  await chat.refreshSession();
  await h.ready();

  expect(sessionChecks).toBe(3);
  expect(profileChecks).toBe(1);
  expect(apiClient.getCurrentUser()?.id).toBe("account-b");
  expect(apiClient.getSessionToken()).toBe("token-b");
  expect(apiClient.getVerifiedSessionIdentity()).not.toBeNull();
  expect(h.local()).toEqual({ account: "b" });
  expect(h.controller.getStatus().revision).toBe(2);
});
