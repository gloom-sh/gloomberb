import { describe, expect, test } from "bun:test";

import {
  createPluginAutoUpdateScheduler,
  pluginAutoUpdateEnabled,
  runPluginAutoUpdate,
  type PluginAutoUpdateDeps,
  type PluginAutoUpdateResult,
  type PluginAutoUpdateState,
  type PluginCheckout,
} from "./auto-update";
import type { RegistryPlugin } from "./builtin/plugin-marketplace/model";
import type { PluginOperationResult, PluginPin } from "./builtin/plugin-marketplace/store";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

function listing(repo: string, extra: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return {
    id: repo.split("/")[1]!,
    name: repo,
    tagline: "",
    repo,
    author: { name: "" },
    categories: [],
    targets: ["tui"],
    hosts: [],
    contributes: { panes: [], capabilities: [], broker: false },
    tier: "official",
    bundled: false,
    stars: 0,
    ...extra,
  };
}

function checkout(directory: string, extra: Partial<PluginCheckout> = {}): PluginCheckout {
  return {
    directory,
    repo: `gloom-sh/${directory}`,
    commit: OLD,
    version: "1.0.0",
    linked: false,
    needsGloomberb: null,
    peers: [],
    hasDependencies: false,
    ...extra,
  };
}

/** Fakes for git and the registry: nothing here touches the network or a checkout. */
function fakeDeps(options: {
  registry: RegistryPlugin[] | null;
  checkouts: PluginCheckout[];
  remoteHeads?: Record<string, string>;
  changed?: string[];
  hasBun?: boolean;
  update?: (directory: string) => PluginOperationResult;
}) {
  const updates: Array<{ directory: string; pin?: PluginPin }> = [];
  const deps: PluginAutoUpdateDeps = {
    checkouts: async () => options.checkouts,
    registry: async () => options.registry,
    remoteHead: async (directory) => options.remoteHeads?.[directory] ?? null,
    hasLocalChanges: async (directory) => options.changed?.includes(directory) ?? false,
    hasBun: () => options.hasBun ?? true,
    update: async (directory, pin) => {
      updates.push({ directory, ...(pin ? { pin } : {}) });
      return options.update?.(directory) ?? { ok: true, directory, changed: true };
    },
    log: () => {},
    hostVersion: "0.16.0",
  };
  return { deps, updates };
}

describe("runPluginAutoUpdate", () => {
  test("updates official plugins with a newer version, a peer before the plugin built on it", async () => {
    const { deps, updates } = fakeDeps({
      registry: [
        listing("gloom-sh/gloom-ibkr-gateway", { ref: "v1.2.0" }),
        listing("gloom-sh/gloom-ibkr", { ref: "v1.2.0" }),
        listing("gloom-sh/gloom-polls"),
      ],
      checkouts: [
        checkout("gloom-ibkr-gateway", { peers: ["gloom-ibkr"] }),
        checkout("gloom-ibkr"),
        checkout("gloom-polls"),
      ],
      remoteHeads: { "gloom-polls": NEW },
    });

    const result = await runPluginAutoUpdate(deps);

    expect(updates).toEqual([
      { directory: "gloom-ibkr", pin: { ref: "v1.2.0" } },
      { directory: "gloom-ibkr-gateway", pin: { ref: "v1.2.0" } },
      // Unpinned: follows the default branch, like a manual update.
      { directory: "gloom-polls" },
    ]);
    expect(result).toEqual({ checked: true, updated: ["gloom-ibkr", "gloom-ibkr-gateway", "gloom-polls"] });
  });

  test("leaves third-party plugins, forks and repositories the registry does not list alone", async () => {
    const { deps, updates } = fakeDeps({
      registry: [
        listing("someone/weather", { ref: "v2.0.0", tier: "community" }),
        listing("gloom-sh/gloom-tv", { ref: "v2.0.0" }),
      ],
      checkouts: [
        checkout("weather", { repo: "someone/weather" }),
        // Same plugin, cloned from a fork: not what Gloom published.
        checkout("gloom-tv", { repo: "someone/gloom-tv" }),
        checkout("gloom-private", { repo: "gloom-sh/gloom-private" }),
        checkout("copied", { repo: null }),
      ],
      remoteHeads: { "gloom-private": NEW },
    });

    expect(await runPluginAutoUpdate(deps)).toEqual({ checked: true, updated: [] });
    expect(updates).toEqual([]);
  });

  test("only moves forward", async () => {
    const { deps, updates } = fakeDeps({
      registry: [
        listing("gloom-sh/ahead", { ref: "v1.1.0" }),
        listing("gloom-sh/current"),
        listing("gloom-sh/kept", { ref: "v1.1.0" }),
      ],
      checkouts: [
        // Installed from the default branch, past the newest tag.
        checkout("ahead", { version: "1.2.0" }),
        checkout("current"),
        checkout("kept"),
      ],
      remoteHeads: { current: OLD },
      // The installer finds the tag older than the checkout after all.
      update: (directory) => ({ ok: true, directory, kept: "the registry's v1.1.0 is older than the installed 1.0.0" }),
    });

    expect(await runPluginAutoUpdate(deps)).toEqual({ checked: true, updated: [] });
    expect(updates.map((update) => update.directory)).toEqual(["kept"]);
  });

  test("skips linked, locally edited and too-new checkouts, and what is built on them", async () => {
    const { deps, updates } = fakeDeps({
      registry: [
        listing("gloom-sh/linked", { ref: "v2.0.0" }),
        listing("gloom-sh/edited", { ref: "v2.0.0" }),
        listing("gloom-sh/built-on-edited", { ref: "v2.0.0" }),
        listing("gloom-sh/registry-too-new", { ref: "v2.0.0", minGloomberb: "0.17.0" }),
        listing("gloom-sh/checkout-too-new", { ref: "v2.0.0" }),
        listing("gloom-sh/needs-bun", { ref: "v2.0.0" }),
      ],
      checkouts: [
        checkout("linked", { linked: true }),
        checkout("edited"),
        checkout("built-on-edited", { peers: ["edited"] }),
        checkout("registry-too-new"),
        checkout("checkout-too-new", { needsGloomberb: "0.17.0" }),
        checkout("needs-bun", { hasDependencies: true }),
      ],
      changed: ["edited"],
      hasBun: false,
    });

    expect(await runPluginAutoUpdate(deps)).toEqual({ checked: true, updated: [] });
    expect(updates).toEqual([]);
  });

  test("decides nothing while the registry is unreachable", async () => {
    const { deps, updates } = fakeDeps({ registry: null, checkouts: [checkout("gloom-tv")] });
    expect(await runPluginAutoUpdate(deps)).toEqual({ checked: false, updated: [] });
    expect(updates).toEqual([]);
  });

  test("a plugin that failed on a missing host export updates only when something newer exists", async () => {
    const registry = [listing("gloom-sh/stale"), listing("gloom-sh/fixed"), listing("gloom-sh/other")];
    const checkouts = [checkout("stale"), checkout("fixed"), checkout("other")];
    const { deps, updates } = fakeDeps({ registry, checkouts, remoteHeads: { stale: OLD, fixed: NEW, other: NEW } });

    expect(await runPluginAutoUpdate(deps, ["stale", "fixed"])).toEqual({ checked: true, updated: ["fixed"] });
    expect(updates.map((update) => update.directory)).toEqual(["fixed"]);
  });
});

describe("plugin update schedule", () => {
  const DAY = 24 * 60 * 60_000;

  function schedule(options: {
    state?: PluginAutoUpdateState | null;
    enabled?: boolean;
    missing?: string[];
    result?: PluginAutoUpdateResult;
    now: number;
    hostVersion?: string;
  }) {
    let state = options.state ?? null;
    const runs: Array<readonly string[] | undefined> = [];
    const applied: string[][] = [];
    const scheduler = createPluginAutoUpdateScheduler({
      isEnabled: () => options.enabled ?? true,
      run: async (only) => {
        runs.push(only);
        return options.result ?? { checked: true, updated: [] };
      },
      missingHostExports: () => options.missing ?? [],
      readState: () => state,
      writeState: (next) => { state = next; },
      onUpdated: (directories) => { applied.push(directories); },
      log: () => {},
      now: () => options.now,
      hostVersion: options.hostVersion ?? "0.16.0",
    });
    return { scheduler, runs, applied, state: () => state };
  }

  test("checks once on a new Gloomberb version and then once a day", async () => {
    const first = schedule({ now: 1_000 });
    await first.scheduler.tick(true);
    expect(first.runs).toEqual([undefined]);
    expect(first.state()).toEqual({ checkedAt: 1_000, hostVersion: "0.16.0" });

    const sameDay = schedule({ state: first.state(), now: 1_000 + DAY - 1 });
    await sameDay.scheduler.tick(true);
    await sameDay.scheduler.tick(false);
    expect(sameDay.runs).toEqual([]);

    const nextDay = schedule({ state: first.state(), now: 1_000 + DAY });
    await nextDay.scheduler.tick(false);
    expect(nextDay.runs).toEqual([undefined]);

    const upgraded = schedule({ state: first.state(), now: 2_000, hostVersion: "0.16.1" });
    await upgraded.scheduler.tick(true);
    expect(upgraded.runs).toEqual([undefined]);
    expect(upgraded.state()).toEqual({ checkedAt: 2_000, hostVersion: "0.16.1" });
  });

  test("tries again on the next pass when the registry could not be read", async () => {
    const offline = schedule({ now: 1_000, result: { checked: false, updated: [] } });
    await offline.scheduler.tick(true);
    expect(offline.state()).toBeNull();
  });

  test("at startup, checks plugins that failed on a missing host export even when the daily check is not due", async () => {
    const recent = { checkedAt: 1_000, hostVersion: "0.16.0" };
    const run = schedule({ state: recent, now: 2_000, missing: ["gloom-tv"], result: { checked: true, updated: ["gloom-tv"] } });
    await run.scheduler.tick(false);
    expect(run.runs).toEqual([]);
    await run.scheduler.tick(true);
    expect(run.runs).toEqual([["gloom-tv"]]);
    expect(run.applied).toEqual([["gloom-tv"]]);
    // Not a full check, so the daily one keeps its time.
    expect(run.state()).toEqual(recent);
  });

  test("does nothing with the setting off", async () => {
    const off = schedule({ now: 1_000, enabled: false, missing: ["gloom-tv"] });
    await off.scheduler.tick(true);
    expect(off.runs).toEqual([]);

    expect(pluginAutoUpdateEnabled({ pluginConfig: {} })).toBe(true);
    expect(pluginAutoUpdateEnabled({ pluginConfig: { application: { autoUpdateOfficialPlugins: false } } })).toBe(false);
  });
});
