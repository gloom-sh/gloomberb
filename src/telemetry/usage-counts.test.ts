import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UsageCountsPayload } from "../api-client";
import { setExternalPlugins } from "../plugins/external-runtime";
import type { GloomPlugin } from "../types/plugin";
import {
  describeUsageFunction,
  flushUsageCounts,
  installUsageCounter,
  recordFunctionOpen,
  recordRestoredFunctions,
  rememberBuiltinPlugins,
  resetUsageCountsForTests,
  usageCountsEnabled,
  usageTelemetryAllowed,
  usageFunctionForPane,
  type UsageCounterHost,
} from "./usage-counts";

function fakeHost(overrides: Partial<UsageCounterHost> = {}) {
  const sent: UsageCountsPayload[] = [];
  const host: UsageCounterHost = {
    surface: "terminal",
    os: "linux 6.1 x64",
    isEnabled: () => true,
    getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
    officialPluginIds: async () => new Set(["fear-greed"]),
    send: async (payload) => {
      sent.push(payload);
    },
    ...overrides,
  };
  return { host, sent };
}

const builtin = (shortcut: string) => ({ shortcut, externalPluginId: null });
const external = (pluginId: string, shortcut: string) => ({ shortcut, externalPluginId: pluginId });
/** Lets the official plugin lookup that counting starts come back. */
const settle = () => Bun.sleep(0);
const plugin = (id: string) => ({ id, name: id, version: "1.0.0" }) as GloomPlugin;

// Other test files open panes through the same module, so start clean too.
beforeEach(() => {
  resetUsageCountsForTests();
});

afterEach(() => {
  resetUsageCountsForTests();
});

describe("usageCountsEnabled", () => {
  test("on unless the config or the environment says otherwise", () => {
    expect(usageCountsEnabled(null)).toBe(true);
    expect(usageCountsEnabled({ telemetry: { crashReports: false } })).toBe(true);
    expect(usageCountsEnabled({ telemetry: { usage: false } })).toBe(false);
    expect(usageCountsEnabled({}, { GLOOMBERB_NO_TELEMETRY: "1" })).toBe(false);
    expect(usageCountsEnabled({}, { DO_NOT_TRACK: "true" })).toBe(false);
    expect(usageCountsEnabled({}, { DO_NOT_TRACK: "0" })).toBe(true);
  });
});

describe("usageTelemetryAllowed", () => {
  // Command-bar searches ride on this: an installed surface's own opt-out
  // (Do Not Track, GPC, the desktop launch environment) must stop them too.
  test("honours the config switch and the installed surface's opt-out", () => {
    expect(usageTelemetryAllowed({})).toBe(true);
    expect(usageTelemetryAllowed({ telemetry: { usage: false } })).toBe(false);
    installUsageCounter(fakeHost({ isEnabled: () => false }).host);
    expect(usageTelemetryAllowed({})).toBe(false);
  });
});

describe("usage counts", () => {
  test("adds up opens per function and counts the restored workspace once", async () => {
    const { host, sent } = fakeHost();
    installUsageCounter(host);
    recordRestoredFunctions([builtin("DES"), builtin("GP"), builtin("GP")]);
    recordRestoredFunctions([builtin("PORT")]);
    recordFunctionOpen(builtin("DES"));
    recordFunctionOpen(builtin("des"));
    recordFunctionOpen(builtin("FA"));
    await flushUsageCounts({ timeoutMs: 500 });

    expect(sent).toEqual([{
      installId: "0f1e2d3c-4b5a-4968-8776-655443322110",
      surface: "terminal",
      appVersion: expect.any(String),
      os: "linux 6.1 x64",
      counts: [
        { fn: "DES", opened: 2, restored: 1 },
        { fn: "GP", opened: 0, restored: 2 },
        { fn: "FA", opened: 1, restored: 0 },
      ],
    }]);
  });

  test("sends a function under its mnemonic only when it is built in or official", async () => {
    const { host, sent } = fakeHost();
    installUsageCounter(host);
    recordFunctionOpen(external("fear-greed", "FNG"));
    recordFunctionOpen(external("acme-internal", "ACMEDEAL"));
    recordFunctionOpen(external("someones-plugin", "MYFN"));
    recordFunctionOpen(external("someones-plugin", ""));
    // Not a mnemonic: a built-in without one has nothing to send.
    recordFunctionOpen(builtin("FONT+"));
    recordFunctionOpen(builtin(""));
    await settle();
    await flushUsageCounts({ timeoutMs: 500 });

    expect(sent[0]!.counts).toEqual([
      { fn: "FNG", opened: 1, restored: 0 },
      { fn: "plugin", opened: 3, restored: 0 },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/acme|ACMEDEAL|MYFN|someones/i);
  });

  test("every external plugin is `plugin` when the official list cannot be read", async () => {
    const { host, sent } = fakeHost({
      officialPluginIds: async () => {
        throw new Error("offline");
      },
    });
    installUsageCounter(host);
    recordFunctionOpen(external("fear-greed", "FNG"));
    await settle();
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent[0]!.counts).toEqual([{ fn: "plugin", opened: 1, restored: 0 }]);
  });

  test("an exit flush sends at once rather than wait for the official list", async () => {
    const { host, sent } = fakeHost({ officialPluginIds: () => new Promise(() => {}) });
    installUsageCounter(host);
    recordFunctionOpen(builtin("DES"));
    recordFunctionOpen(external("fear-greed", "FNG"));
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent[0]!.counts).toEqual([
      { fn: "DES", opened: 1, restored: 0 },
      { fn: "plugin", opened: 1, restored: 0 },
    ]);
  });

  test("nothing is counted or sent when the switch is off, and turning it off drops what was counted", async () => {
    let enabled = false;
    const { host, sent } = fakeHost({ isEnabled: () => enabled });
    installUsageCounter(host);
    recordFunctionOpen(builtin("DES"));
    recordRestoredFunctions([builtin("GP")]);
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent).toHaveLength(0);

    enabled = true;
    recordFunctionOpen(builtin("FA"));
    enabled = false;
    await flushUsageCounts({ timeoutMs: 500 });
    enabled = true;
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent).toHaveLength(0);
  });

  test("sending picks up again after the switch was off when a batch was due", async () => {
    let enabled = true;
    const { host, sent } = fakeHost({ isEnabled: () => enabled });
    installUsageCounter(host);
    recordFunctionOpen(builtin("DES"));
    enabled = false;
    await flushUsageCounts({ timeoutMs: 500 });
    enabled = true;
    recordFunctionOpen(builtin("GP"));
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent.map((payload) => payload.counts)).toEqual([[{ fn: "GP", opened: 1, restored: 0 }]]);
  });

  test("counts made before the host is installed wait for it, and are dropped if it is off", async () => {
    recordFunctionOpen(builtin("DES"));
    const { host, sent } = fakeHost({ isEnabled: () => false });
    const uninstall = installUsageCounter(host);
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent).toHaveLength(0);
    uninstall();

    recordFunctionOpen(builtin("GP"));
    const on = fakeHost();
    installUsageCounter(on.host);
    await flushUsageCounts({ timeoutMs: 500 });
    expect(on.sent[0]!.counts).toEqual([{ fn: "GP", opened: 1, restored: 0 }]);
  });

  test("a failed send is dropped quietly, such as a server without the endpoint", async () => {
    const { host } = fakeHost({
      send: async () => {
        throw Object.assign(new Error("Not found"), { status: 404 });
      },
    });
    installUsageCounter(host);
    recordFunctionOpen(builtin("DES"));
    await flushUsageCounts({ timeoutMs: 500 });
    const next = fakeHost();
    installUsageCounter(next.host);
    recordFunctionOpen(builtin("GP"));
    await flushUsageCounts({ timeoutMs: 500 });
    expect(next.sent.map((payload) => payload.counts)).toEqual([[{ fn: "GP", opened: 1, restored: 0 }]]);
  });

  test("holds at most 200 functions and clamps each count", async () => {
    const { host, sent } = fakeHost();
    installUsageCounter(host);
    for (let index = 0; index < 250; index += 1) recordFunctionOpen(builtin(`F${index}`));
    for (let index = 0; index < 1_200; index += 1) recordFunctionOpen(builtin("F0"));
    await flushUsageCounts({ timeoutMs: 500 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.counts).toHaveLength(200);
    expect(sent[0]!.counts[0]).toEqual({ fn: "F0", opened: 1_000, restored: 0 });
  });
});

describe("describeUsageFunction", () => {
  test("keeps a mnemonic only for built-in plugins and plugins installed from gloom-sh", () => {
    const portfolio = plugin("portfolio");
    const official = plugin("fear-greed");
    const bundled = plugin("polls");
    const fork = plugin("market-halts");
    const acme = plugin("acme");
    const justInstalled = plugin("fresh");
    // A failed external plugin that claims a built-in id is not that built-in.
    const impostor = plugin("portfolio");
    rememberBuiltinPlugins([portfolio]);
    setExternalPlugins([
      { plugin: official, path: "/plugins/gloom-fear-greed", directory: "gloom-fear-greed", repo: "gloom-sh/gloom-fear-greed" },
      { plugin: bundled, path: "/plugins/polls.js" },
      { plugin: fork, path: "/plugins/halts", directory: "halts", repo: "acme-co/gloom-market-halts" },
      { plugin: acme, path: "/plugins/acme", directory: "acme" },
      { plugin: impostor, path: "/plugins/bad", directory: "bad", error: "failed" },
    ]);
    const registry = {
      allPlugins: new Map<string, GloomPlugin>([
        ["portfolio", portfolio],
        ["fear-greed", official],
        ["polls", bundled],
        ["market-halts", fork],
        ["acme", acme],
        ["fresh", justInstalled],
      ]),
    };

    expect(describeUsageFunction(registry, "portfolio", "PF")).toEqual({ shortcut: "PF", externalPluginId: null });
    expect(describeUsageFunction(registry, undefined, "DES")).toEqual({ shortcut: "DES", externalPluginId: null });
    expect(describeUsageFunction(registry, "fear-greed", "FNG")).toEqual({ shortcut: "FNG", externalPluginId: "fear-greed" });
    expect(describeUsageFunction(registry, "polls", "POLL")).toEqual({ shortcut: "POLL", externalPluginId: "polls" });
    for (const id of ["market-halts", "acme", "fresh", "gone"]) {
      expect(describeUsageFunction(registry, id, "SECRET")).toEqual({ shortcut: null, externalPluginId: id });
    }
  });

  test("a restored pane is named by the plugin whose template names it", () => {
    const twitter = plugin("gloomberb-cloud");
    const acme = plugin("acme");
    rememberBuiltinPlugins([twitter]);
    setExternalPlugins([{ plugin: acme, path: "/plugins/acme", directory: "acme", repo: "gloom-sh/acme" }]);
    const owners = new Map([["twitter-feed-pane", "gloomberb-cloud"], ["acme-feed", "acme"]]);
    const registry = {
      allPlugins: new Map<string, GloomPlugin>([["gloomberb-cloud", twitter], ["acme", acme]]),
      paneTemplates: new Map([
        ["twitter-feed-pane", { id: "twitter-feed-pane", paneId: "x-feed", label: "X", description: "" }],
        ["acme-feed", { id: "acme-feed", paneId: "x-feed", label: "Acme", description: "", shortcut: { prefix: "ACMEX" } }],
      ]),
      getPanePluginId: () => "gloomberb-cloud",
      getPaneTemplatePluginId: (id: string) => owners.get(id),
    } as unknown as Parameters<typeof usageFunctionForPane>[0];

    expect(usageFunctionForPane(registry, "x-feed")).toEqual({ shortcut: "ACMEX", externalPluginId: "acme" });
  });
});
