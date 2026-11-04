import { expect, test } from "bun:test";

import { getPluginSeedProgress, publishPluginSeedProgress, type PluginSeedEntry, type PluginSeedProgress } from "../../plugins/seed-progress";
import type { AppConfig } from "../../types/config";
import { startPluginSeedConsumer, withPluginSeedRecord } from "./plugin-seed";

function publish(plugins: PluginSeedEntry[], outcome?: PluginSeedProgress["outcome"]): void {
  publishPluginSeedProgress({ seq: (getPluginSeedProgress()?.seq ?? 0) + 1, plugins, ...(outcome ? { outcome } : {}) });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The launch's restore lands plugins while the app runs. The app brings each
 * into the session once the plugins it started with have registered, in the
 * order they landed, each once, and only then records the outcome, so the
 * config never says restored about a plugin the session has not taken.
 */
test("brings restored plugins in after startup, once each, then records the outcome and says what failed", async () => {
  const ready = deferred();
  const activated: string[] = [];
  const recorded: unknown[] = [];
  const notices: string[] = [];
  const running = new Set(["gloom-tv"]);
  const stop = startPluginSeedConsumer({
    ready: ready.promise,
    activate: async ({ directory, peers }) => {
      activated.push([...peers, directory].join("+"));
      running.add(directory);
      return directory === "gloom-public"
        ? { ok: false, error: "broken", name: "Public" }
        : { ok: true, pluginId: directory, name: directory };
    },
    isRunning: (directory) => running.has(directory),
    brokerTypes: () => [],
    syncBrokers: () => {},
    record: (record) => { recorded.push(record); },
    notify: (notice) => { notices.push(notice.body); },
  });

  publish([
    { id: "tv", name: "TV", state: "installed", directory: "gloom-tv" },
    { id: "ibkr-gateway", name: "IBKR Gateway", state: "installed", directory: "gloom-ibkr-gateway", peers: ["gloom-ibkr"] },
    { id: "public", name: "Public", state: "installing" },
  ]);
  await Bun.sleep(0);
  // Not before the plugins the app started with have registered.
  expect(activated).toEqual([]);
  ready.resolve();
  await Bun.sleep(0);

  const record = { seededPlugins: ["ibkr-gateway", "public", "tv"], pluginSeedFailure: { plugins: ["polls"], gitMissing: false } };
  publish([
    { id: "tv", name: "TV", state: "installed", directory: "gloom-tv" },
    { id: "ibkr-gateway", name: "IBKR Gateway", state: "installed", directory: "gloom-ibkr-gateway", peers: ["gloom-ibkr"] },
    { id: "public", name: "Public", state: "installed", directory: "gloom-public" },
    { id: "polls", name: "Polls", state: "failed" },
  ], { record, notice: { type: "info", body: "Polls could not be installed. Gloom tries again at the next launch." } });
  await Bun.sleep(10);

  // TV was already running: a plugin is never registered twice.
  expect(activated).toEqual(["gloom-ibkr+gloom-ibkr-gateway", "gloom-public"]);
  expect(recorded).toEqual([record]);
  expect(notices).toEqual([
    "Polls could not be installed. Gloom tries again at the next launch.",
    "Public installed but did not load. Open Plugins to see why.",
  ]);
  stop();
});

/**
 * The launch syncs saved broker profiles before a restored broker plugin is
 * back, so that sync has no broker to ask. Without another once it registers,
 * the profile's positions stay as they were until the next launch.
 */
test("a restored broker plugin syncs the profiles of the broker types it brought", async () => {
  const brokers = new Set(["gloomberb-cloud"]);
  const synced: string[][] = [];
  const stop = startPluginSeedConsumer({
    ready: Promise.resolve(),
    activate: async ({ directory }) => {
      if (directory === "gloom-ibkr") brokers.add("ibkr");
      return { ok: true, pluginId: directory, name: directory };
    },
    isRunning: () => false,
    brokerTypes: () => brokers,
    syncBrokers: (types) => { synced.push([...types]); },
    record: () => {},
    notify: () => {},
  });
  publish([
    { id: "polls", name: "Polls", state: "installed", directory: "gloom-polls" },
    { id: "ibkr", name: "Interactive Brokers", state: "installed", directory: "gloom-ibkr" },
  ]);
  await Bun.sleep(10);
  expect(synced).toEqual([["ibkr"]]);
  stop();
});

test("the record keeps every plugin restored before, and takes this launch's failure", () => {
  const config = { seededPlugins: ["absorbed:heatmap", "tv"], pluginSeedFailure: { plugins: ["polls", "tv"], gitMissing: false } } as unknown as AppConfig;
  const next = withPluginSeedRecord(config, { seededPlugins: ["polls", "tv"], pluginSeedFailure: undefined });
  expect(next?.seededPlugins).toEqual(["absorbed:heatmap", "polls", "tv"]);
  expect(next && "pluginSeedFailure" in next).toBe(false);
  expect(withPluginSeedRecord(next!, { seededPlugins: ["polls"], pluginSeedFailure: undefined })).toBeNull();
});
