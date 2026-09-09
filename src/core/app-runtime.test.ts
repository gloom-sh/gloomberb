import { afterEach, expect, test } from "bun:test";
import { JsonPersistence } from "../data/json-persistence";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { getSharedMarketDataCoordinator } from "../market-data/coordinator";
import { getSharedNewsService } from "../news/hooks";
import { getSharedRegistry, getSharedMarketData } from "../plugins/registry";
import { createTestDataProvider } from "../test-support/data-provider";
import { createDefaultConfig } from "../types/config";
import { createAppRuntime } from "./app-runtime";

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
