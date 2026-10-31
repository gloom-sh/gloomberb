import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport, type AuthUser } from "./index";
import { ChatController } from "../plugins/builtin/chat/controller";
import { MemoryPluginPersistence } from "../test-support/plugin-persistence";

const pro: AuthUser = { id: "controlled", username: "Controlled", name: "Controlled", email: "test@example.invalid", emailVerified: true, plan: "pro", image: null, createdAt: "", updatedAt: "" };
const free: AuthUser = { ...pro, emailVerified: false, plan: "free" };
let controller: ChatController;
function restore(user = pro, token = "current-token") {
  apiClient.setSessionToken(token);
  apiClient.restoreCachedUser(user);
}
function attach() {
  const persistence = new MemoryPluginPersistence();
  persistence.setState("session", { sessionToken: "current-token", user: free }, { schemaVersion: 1 });
  controller.attachPersistence(persistence);
}
beforeEach(() => {
  apiClient.dispose(); apiClient.setSessionToken(null); apiClient.setCookieSessionMode(false);
  controller = new ChatController();
});
afterEach(() => {
  controller.dispose(); apiClient.dispose(); apiClient.setSessionToken(null);
  setCloudApiFetchTransport(null);
});

test.each(["dispose", "adopt"])("real HTTP session response cannot overwrite a newer account after controller %s", async (change) => {
  attach();
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  setCloudApiFetchTransport(async () => ++requests === 1 ? response.promise : Response.json({ user: pro }));
  const pending = controller.refreshSession();
  if (change === "dispose") { controller.dispose(); restore(); }
  else controller.adoptSession("current-token", pro);
  apiClient.setWebSocketToken("current-ws");
  response.resolve(Response.json({ user: null, token: "retired-ws" }, { headers: { "set-cookie": "gloomberb.session_token=retired-token; Path=/" } }));
  await pending;
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
  expect(apiClient.getSessionToken()).toBe("current-token");
  expect(apiClient.getWebSocketToken()).toBe("current-ws");
  expect(requests).toBe(1);
  expect((controller as any).realtime.sessionRetryTimer).toBeNull();
});

test("a current independent caller keeps a shared session request valid after another caller retires", async () => {
  restore();
  let active = true;
  let requests = 0;
  const response = Promise.withResolvers<Response>();
  setCloudApiFetchTransport(async () => { requests++; return response.promise; });
  const retired = apiClient.getSession(() => active);
  const independent = apiClient.getSession();
  active = false;
  response.resolve(Response.json({ user: free, token: "accepted-ws" }));
  await Promise.all([retired, independent]);
  expect(requests).toBe(1);
  expect(apiClient.getCurrentUser()).toMatchObject(free);
  expect(apiClient.getWebSocketToken()).toBe("accepted-ws");
});

test.each(["retired-callers", "api-dispose"])("old body completion cannot clear a newer single-flight request: %s", async (retire) => {
  restore();
  let active = true;
  let requests = 0;
  const readingBody = Promise.withResolvers<void>();
  const oldBody = Promise.withResolvers<string>();
  const newResponse = Promise.withResolvers<Response>();
  setCloudApiFetchTransport(async () => {
    if (++requests !== 1) return newResponse.promise;
    return { ok: true, status: 200, headers: new Headers(), text: () => { readingBody.resolve(); return oldBody.promise; } };
  });
  const oldRequest = apiClient.getSession(() => active);
  await readingBody.promise;
  if (retire === "api-dispose") apiClient.dispose();
  else active = false;
  const newRequest = apiClient.getSession();
  expect(requests).toBe(2);
  apiClient.setWebSocketToken("current-ws");
  oldBody.resolve(JSON.stringify({ user: null, token: "retired-ws" }));
  await oldRequest;
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
  expect(apiClient.getWebSocketToken()).toBe("current-ws");
  const joined = apiClient.getSession();
  expect(requests).toBe(2);
  newResponse.resolve(Response.json({ user: free }));
  await Promise.all([newRequest, joined]);
  expect(apiClient.getCurrentUser()).toMatchObject(free);
});

test("a newer same-token cached account prevents an older independent response from committing", async () => {
  restore(free);
  const response = Promise.withResolvers<Response>();
  setCloudApiFetchTransport(async () => response.promise);
  const pending = apiClient.getSession();
  restore();
  response.resolve(Response.json({ user: null, token: "retired-ws" }));
  await pending;
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
  expect(apiClient.getWebSocketToken()).toBeNull();
  expect(apiClient.describeAuthState().sessionChecked).toBe(false);
});

for (const status of [200, 401, 403, 503]) test(`real profile ${status} completion remains inert after controller disposal`, async () => {
  attach();
  const started = Promise.withResolvers<void>();
  const profile = Promise.withResolvers<Response>();
  setCloudApiFetchTransport(async (url) => {
    if (new URL(url).pathname === "/auth/get-session") return Response.json({ user: null });
    started.resolve(); return profile.promise;
  });
  const pending = controller.refreshSession();
  await started.promise;
  controller.dispose(); restore(); apiClient.setWebSocketToken("current-ws");
  profile.resolve(Response.json(status === 200 ? { profile: free, token: "retired-ws" } : { message: "Controlled failure" }, { status, headers: { "set-cookie": "gloomberb.session_token=retired-token; Path=/" } }));
  await pending;
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
  expect(apiClient.getSessionToken()).toBe("current-token");
  expect(apiClient.getWebSocketToken()).toBe("current-ws");
  expect((controller as any).realtime.sessionRetryTimer).toBeNull();
});

test("current null, unauthorized and deleted-account responses keep their distinct session semantics", async () => {
  restore();
  setCloudApiFetchTransport(async () => Response.json({ user: null }));
  await expect(apiClient.getSession()).resolves.toBeNull();
  expect(apiClient.getCurrentUser()).toBeNull();
  expect(apiClient.getSessionToken()).toBe("current-token");
  restore();
  setCloudApiFetchTransport(async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
  await expect(apiClient.getSession()).rejects.toThrow("Unauthorized");
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
  setCloudApiFetchTransport(async () => Response.json({ code: "USER_NOT_FOUND" }, { status: 403 }));
  await expect(apiClient.getSession()).resolves.toBeNull();
  expect(apiClient.getSessionToken()).toBeNull();
});

for (const status of [401, 403]) test(`retired real HTTP ${status} cannot clear a current credential`, async () => {
  restore();
  let active = true;
  const response = Promise.withResolvers<Response>();
  setCloudApiFetchTransport(async () => response.promise);
  const pending = apiClient.getSession(() => active);
  active = false;
  response.resolve(Response.json({ code: "USER_NOT_FOUND" }, { status }));
  await pending;
  expect(apiClient.getSessionToken()).toBe("current-token");
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
});

test("current cookie and socket-token rotation remains accepted and revalidates the new credential", async () => {
  restore();
  const cookies: Array<string | null> = [];
  setCloudApiFetchTransport(async (_url, options) => {
    cookies.push(new Headers(options?.headers).get("Cookie"));
    return cookies.length === 1
      ? Response.json({ user: pro, token: "rotated-ws" }, { headers: { "set-cookie": "gloomberb.session_token=rotated-token; Path=/" } })
      : Response.json({ user: pro });
  });
  await apiClient.getSession();
  expect(cookies).toHaveLength(2);
  expect(cookies[1]).toContain("rotated-token");
  expect(apiClient.getSessionToken()).toBe("rotated-token");
  expect(apiClient.getWebSocketToken()).toBe("rotated-ws");
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
});


test("new-credential validation supersedes an older live request without rechecking the retired response", async () => {
  restore(free, "old-token");
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  setCloudApiFetchTransport(async () => ++requests === 1 ? response.promise : Response.json({ user: pro, token: "new-ws" }));
  const old = apiClient.getSession();
  restore(pro, "new-token");
  const current = apiClient.getSession();
  expect(requests).toBe(2);
  await current;
  response.resolve(Response.json({ user: null, token: "old-ws" }, { headers: { "set-cookie": "gloomberb.session_token=old-token; Path=/" } }));
  await old;
  expect(requests).toBe(2);
  expect(apiClient.getSessionToken()).toBe("new-token");
  expect(apiClient.getWebSocketToken()).toBe("new-ws");
  expect(apiClient.getCurrentUser()).toMatchObject(pro);
});

test("a cookie session checked at boot is not asked for again once chat restores its state", async () => {
  apiClient.setCookieSessionMode(true);
  let requests = 0;
  setCloudApiFetchTransport(async () => { requests++; return new Response("", { status: 200 }); });
  await apiClient.getSession();
  controller.attachPersistence(new MemoryPluginPersistence());
  expect(await apiClient.ensureVerifiedSession()).toBeNull();
  expect(requests).toBe(1);
});

test("a refresh may take the session the app checked moments ago, and asks once that check is old", async () => {
  apiClient.setCookieSessionMode(true);
  let requests = 0;
  setCloudApiFetchTransport(async (url) => {
    if (new URL(url).pathname !== "/auth/get-session") return Response.json({ channels: [] });
    requests++;
    return Response.json({ user: pro });
  });
  await apiClient.getSession();
  controller.attachPersistence(new MemoryPluginPersistence());
  await controller.refreshSession({ reuseCheckWithinMs: 30_000 });
  expect(requests).toBe(1);
  expect(controller.getSnapshot().user?.id).toBe(pro.id);
  await controller.refreshSession({ reuseCheckWithinMs: 0 });
  expect(requests).toBe(2);
});
