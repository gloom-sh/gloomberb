import { afterEach, expect, test } from "bun:test";
import { JsonPersistence } from "../data/json-persistence";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { getSharedMarketDataCoordinator } from "../market-data/coordinator";
import { getSharedNewsService } from "../news/hooks";
import { getSharedRegistry, getSharedMarketData } from "../plugins/registry";
import { createTestDataProvider } from "../test-support/data-provider";
import { createDefaultConfig, createPaneInstance } from "../types/config";
import { createAppRuntime } from "./app-runtime";
import { apiClient, setCloudApiFetchTransport } from "../api-client";
import { installTestWebSocket, verifiedUser } from "../test-support/cloud-api";
import { readSavedCopy, writeSavedCopy } from "../data/pane-saved-copies";
import { MemoryResourceStore } from "../data/memory-resource-store";
import { applyResourceSync, createBatchedResourceSink } from "../data/durable-resources";
import { cloudNewsSnapshotScope } from "../news/cloud-session";

const runtimes: ReturnType<typeof createAppRuntime>[] = [];
function runtime(overrides: Partial<Parameters<typeof createAppRuntime>[0]> = {}) {
  const services = createAppRuntime({
    config: createDefaultConfig("/tmp/runtime-test"),
    plugins: [],
    persistence: new JsonPersistence(),
    tickerRepository: new JsonTickerRepository(),
    dataProvider: createTestDataProvider(),
    ...overrides,
  });
  runtimes.push(services);
  return services;
}

afterEach(() => { for (const services of runtimes.splice(0).reverse()) services.destroy(); });

test.each(["downgrade", "sign-out", "switch account"])("news snapshots are purged on %s and reject late writes", async (change) => {
  const proUser = { ...verifiedUser, plan: "pro" } as const;
  apiClient.setSessionToken("news-session");
  apiClient.restoreCachedUser(proUser);
  const durable = new MemoryResourceStore();
  const sink = createBatchedResourceSink((batch) => applyResourceSync(durable, batch));
  const persistence = new JsonPersistence(undefined, { durable: { saved: [], sink } });
  const services = runtime({ persistence });
  try {
    await services.ready;
    const pane = createPaneInstance("news-feed", { instanceId: "news-feed:private" });
    const key = "feed:articles:v2";
    const scope = cloudNewsSnapshotScope()!;
    expect(scope).toBe(JSON.stringify([proUser.id, true, true]));
    const snapshots = services.pluginRegistry.newsPaneSnapshots;
    snapshots.write(pane, "news", key, scope, ["paid data"]);
    expect(snapshots.read(pane, "news", key, scope)).toEqual(["paid data"]);
    const resource = { namespace: "pane:news", kind: "list", entityKey: JSON.stringify([pane.paneId, pane.instanceId]), sourceKey: scope };
    await sink.flush();
    expect(durable.get(resource)).not.toBeNull();
    if (change === "sign-out") apiClient.setSessionToken(null);
    else apiClient.restoreCachedUser(change === "downgrade" ? { ...proUser, plan: "free" } : { ...proUser, id: "another-account" });
    expect(snapshots.read(pane, "news", key, cloudNewsSnapshotScope()!)).toBeNull();
    snapshots.write(pane, "news", key, scope, ["late paid data"]);
    await sink.flush();
    expect(durable.get(resource)).toBeNull();
    if (change === "sign-out") apiClient.setSessionToken("news-session");
    apiClient.restoreCachedUser(proUser);
    expect(snapshots.read(pane, "news", key, scope)).toBeNull();
  } finally {
    services.destroy();
    apiClient.dispose();
    apiClient.setSessionToken(null);
  }
});

test("topic and ticker changes reuse a bounded cache slot, and removed panes can be evicted", async () => {
  const resources = new MemoryResourceStore({ maxRows: 2, maxBytes: 1024 * 1024 });
  const services = runtime({ persistence: { ...new JsonPersistence(), resources, close() {} } });
  await services.ready;
  const scope = cloudNewsSnapshotScope()!;
  const snapshots = services.pluginRegistry.newsPaneSnapshots;
  const industry = createPaneInstance("news-industry", { instanceId: "topics" });
  const ticker = createPaneInstance("ticker-news", { instanceId: "ticker:old" });
  const nextTicker = createPaneInstance("ticker-news", { instanceId: "ticker:new" });
  snapshots.write(ticker, "news", "articles:AAPL::v2", scope, ["old symbol"]);
  snapshots.write(ticker, "news", "articles:NVDA::v2", scope, ["new symbol"]);
  expect(snapshots.read(ticker, "news", "articles:AAPL::v2", scope)).toBeNull();
  for (const topic of ["mna", "metals", "energy", "earn"]) {
    snapshots.write(industry, "news", `industry:topic:${topic}:articles:v2`, scope, Array.from({ length: 220 }, () => topic));
  }
  expect(snapshots.read(industry, "news", "industry:topic:earn:articles:v2", scope)).toHaveLength(200);
  snapshots.write(industry, "news", "industry:topic:earn:articles:v2", scope, ["fits", "x".repeat(256 * 1024)]);
  expect(snapshots.read(industry, "news", "industry:topic:earn:articles:v2", scope)).toEqual(["fits"]);
  expect(snapshots.read(industry, "news", "industry:topic:energy:articles:v2", scope)).toBeNull();
  expect(snapshots.read(ticker, "news", "articles:NVDA::v2", scope)).toEqual(["new symbol"]);
  expect(snapshots.read(industry, "news", "industry:topic:earn:articles:v2", scope)).not.toBeNull();
  snapshots.write(nextTicker, "news", "articles:META::v2", scope, ["new pane"]);
  expect(snapshots.read(ticker, "news", "articles:NVDA::v2", scope)).toBeNull();
  expect(snapshots.read(nextTicker, "news", "articles:META::v2", scope)).toEqual(["new pane"]);
});

test("confirmed Free access purges the account's old Pro copies, not a tentative boot identity or sign-out", async () => {
  const socket = globalThis.WebSocket;
  const proUser = { ...verifiedUser, plan: "pro" } as const;
  const paid = { key: ["risk-factors", JSON.stringify([proUser.id, true, true]), "AAPL"] };
  const other = { key: ["risk-factors", JSON.stringify(["other-account", true, true]), "AAPL"] };
  installTestWebSocket();
  apiClient.setCookieSessionMode(true);
  apiClient.restoreCachedUser({ ...proUser, plan: "free" }, false);
  const services = runtime();
  try {
    await services.ready;
    writeSavedCopy(paid, "paid data");
    writeSavedCopy(other, "other account data");
    setCloudApiFetchTransport(async () => Response.json(null));
    expect(await apiClient.getSession()).toBeNull();
    expect(readSavedCopy(paid)?.value).toBe("paid data");

    setCloudApiFetchTransport(async () => Response.json({ user: { ...proUser, plan: "free" } }));
    expect(await apiClient.getSession()).toMatchObject({ plan: "free" });
    expect(readSavedCopy(paid)).toBeNull();
    expect(readSavedCopy(other)?.value).toBe("other account data");
  } finally {
    services.destroy();
    apiClient.dispose();
    apiClient.setSessionToken(null);
    apiClient.setCookieSessionMode(false);
    setCloudApiFetchTransport(null);
    globalThis.WebSocket = socket;
  }
});

test.each(["session read", "socket ready"])("an unverified socket retains paid copies until a %s confirms the downgrade", async (confirmation) => {
  const originalSocket = globalThis.WebSocket;
  const sockets = installTestWebSocket();
  const proUser = { ...verifiedUser, plan: "pro" } as const;
  const paid = { key: ["risk-factors", JSON.stringify([proUser.id, true, true]), "AAPL"] };
  apiClient.setSessionToken("pro-session");
  apiClient.restoreCachedUser(proUser);
  const services = runtime();
  const stop = apiClient.subscribeQuotes([{ symbol: "AAPL" }], () => {});
  try {
    await services.ready;
    writeSavedCopy(paid, "paid data");
    const downgraded = { ...proUser, plan: "free" };
    const answer = Promise.withResolvers<Response>();
    setCloudApiFetchTransport(async () => answer.promise);
    const session = confirmation === "session read" ? apiClient.getSession() : null;
    sockets.at(-1)!.receive({ type: "auth.unverified" });
    expect(apiClient.getCurrentUser()?.emailVerified).toBe(false);
    expect(readSavedCopy(paid)?.value).toBe("paid data");
    if (session) {
      answer.resolve(Response.json({ user: downgraded }));
      await session;
    } else {
      sockets.at(-1)!.receive({ type: "ready", user: downgraded });
    }
    expect(apiClient.getConfirmedDisplayUser()?.plan).toBe("free");
    expect(readSavedCopy(paid)).toBeNull();
  } finally {
    stop();
    services.destroy();
    apiClient.dispose();
    apiClient.setSessionToken(null);
    setCloudApiFetchTransport(null);
    globalThis.WebSocket = originalSocket;
  }
});

test("retiring an old runtime cannot disconnect its replacement", async () => {
  const dataProvider = createTestDataProvider();
  const previous = runtime({ dataProvider });
  const current = runtime({ dataProvider });
  await Promise.all([previous.ready, current.ready]);
  previous.destroy();
  expect(getSharedRegistry()).toBe(current.pluginRegistry);
  expect(getSharedMarketData()).toBe(dataProvider);
  expect(getSharedMarketDataCoordinator()).toBe(current.marketData);
  expect(getSharedNewsService()).toBe(current.newsService);
  current.destroy();
  expect(getSharedRegistry()).toBeUndefined();
  expect(getSharedMarketDataCoordinator()).toBeNull();
  expect(getSharedNewsService()).toBeNull();
});

test("destroy waits for pending setup before disposing plugins and storage, and skips remote readiness", async () => {
  const setup = Promise.withResolvers<void>();
  const calls: string[] = [];
  const persistence = new JsonPersistence();
  persistence.close = () => { calls.push("close"); };
  const services = runtime({
    persistence,
    plugins: [{
      id: "late-setup", name: "Late setup", version: "1",
      async setup(context) {
        await setup.promise;
        expect(calls).toEqual([]);
        context.resume.setState("draft", "saved");
        context.registerPane({ id: "late-pane", name: "Late pane", component: () => null });
        calls.push("setup");
      },
      dispose() { calls.push("plugin"); },
    }],
    onReady: () => { calls.push("remote-connected"); },
  });
  services.destroy();
  services.destroy();
  expect(getSharedRegistry()).toBeUndefined();
  setup.resolve();
  await services.ready;
  expect(calls).toEqual(["setup", "plugin", "close"]);
  expect(services.pluginRegistry.panes.size).toBe(0);
  expect(persistence.pluginState.get("late-setup", "resume:draft")?.value).toBe("saved");
});

test("teardown releases every owner and closes persistence even when a host disposer throws", async () => {
  const calls: string[] = [];
  const persistence = new JsonPersistence();
  persistence.close = () => { calls.push("close"); };
  const services = runtime({
    persistence,
    plugins: [{ id: "cleanup", name: "Cleanup", version: "1", dispose() { calls.push("plugin"); } }],
    configure: () => () => { calls.push("host"); throw new Error("host failed"); },
    onReady: () => () => { calls.push("remote"); throw new Error("remote failed"); },
  });
  await services.ready;
  expect(() => services.destroy()).toThrow("App runtime teardown failed");
  expect(calls).toEqual(["remote", "plugin", "host", "close"]);
  expect(getSharedRegistry()).toBeUndefined();
  expect(getSharedMarketDataCoordinator()).toBeNull();
  expect(getSharedNewsService()).toBeNull();
  services.destroy();
  expect(calls).toHaveLength(4);
});

test("an external plugin that cannot register is marked failed and the app still comes up", async () => {
  // #898: a plugin under ~/.gloomberb/plugins with a reserved or duplicate
  // id, or a setup() that throws, used to abort startup. The registry has
  // undone its partial registration by the time the runtime hears about it.
  const reserved = { id: "help", name: "Help lookalike", version: "1" };
  const throwing = { id: "throwing", name: "Throwing", version: "1", setup() { throw new Error("setup failed"); } };
  const healthy = { id: "healthy", name: "Healthy", version: "1" };
  const externalPlugins = [
    { plugin: reserved, path: "/plugins/help-lookalike", directory: "help-lookalike" },
    { plugin: throwing, path: "/plugins/throwing", directory: "throwing" },
    { plugin: healthy, path: "/plugins/healthy", directory: "healthy" },
  ];
  const services = runtime({ plugins: [reserved, throwing, healthy], externalPlugins });

  await services.ready;

  expect(externalPlugins[0]!.error).toBe("Registration failed: Plugin id is reserved by a built-in module: help");
  expect(externalPlugins[1]!.error).toBe("Registration failed: setup failed");
  expect(externalPlugins[2]!.error).toBeUndefined();
  expect([...services.pluginRegistry.allPlugins.keys()]).toEqual(["healthy"]);
  expect(getSharedRegistry()).toBe(services.pluginRegistry);
});

test("an external plugin that registers a contribution without an id is marked failed and leaves no entry behind", async () => {
  const bySetup = {
    id: "by-setup",
    name: "By setup",
    version: "1",
    setup(context: { registerCommand(command: unknown): void }) {
      context.registerCommand({ id: "by-setup:ok", label: "Fine", keywords: [], category: "data", execute() {} });
      context.registerCommand({ label: "Run it", keywords: [], category: "data", execute() {} });
    },
  };
  const byPane = { id: "by-pane", name: "By pane", version: "1", panes: [{ name: "Unnamed", component: () => null, defaultPosition: "left" }] };
  const healthy = { id: "healthy", name: "Healthy", version: "1" };
  const externalPlugins = [
    { plugin: bySetup, path: "/plugins/by-setup", directory: "by-setup" },
    { plugin: byPane, path: "/plugins/by-pane", directory: "by-pane" },
    { plugin: healthy, path: "/plugins/healthy", directory: "healthy" },
  ];
  const services = runtime({ plugins: [bySetup, byPane, healthy] as never, externalPlugins: externalPlugins as never });

  await services.ready;

  expect(externalPlugins[0]!.plugin).toBe(bySetup);
  expect((externalPlugins[0] as { error?: string }).error).toBe(
    'Registration failed: Plugin "by-setup" registered a command ("Run it") that has no id. Give every command a non-empty string `id`.',
  );
  expect((externalPlugins[1] as { error?: string }).error).toBe(
    'Registration failed: Plugin "by-pane" registered a pane ("Unnamed") that has no id. Give every pane a non-empty string `id`.',
  );
  expect((externalPlugins[2] as { error?: string }).error).toBeUndefined();
  expect([...services.pluginRegistry.allPlugins.keys()]).toEqual(["healthy"]);
  expect([...services.pluginRegistry.commands.keys()].filter((id) => typeof id !== "string" || id.startsWith("by-"))).toEqual([]);
  expect([...services.pluginRegistry.panes.keys()].filter((id) => typeof id !== "string")).toEqual([]);
});

test("a built-in that cannot register still fails startup", async () => {
  const services = runtime({
    plugins: [{ id: "builtin-broken", name: "Broken", version: "1", setup() { throw new Error("builtin broke"); } }],
    externalPlugins: [],
  });
  await expect(services.ready).rejects.toThrow("builtin broke");
});

test("failed setup still waits for other plugins before closing their storage", async () => {
  const setup = Promise.withResolvers<void>();
  let closed = false;
  const persistence = new JsonPersistence();
  persistence.close = () => { closed = true; };
  const services = runtime({
    persistence,
    plugins: [
      { id: "failed", name: "Failed", version: "1", setup() { throw new Error("setup failed"); } },
      { id: "waiting", name: "Waiting", version: "1", async setup(context) {
        await setup.promise;
        expect(closed).toBe(false);
        context.resume.setState("draft", "saved");
      } },
    ],
  });
  setup.resolve();
  await expect(services.ready).rejects.toThrow("setup failed");
  expect(closed).toBe(true);
  expect(getSharedRegistry()).toBeUndefined();
});
