import { describe, expect, test } from "bun:test";
import type { RegistryPlugin } from "../../../../plugins/builtin/plugin-marketplace/model";
import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import type { Command } from "../../commands/registry";
import {
  collectClaimedShortcutCodes,
  isRegistryPluginInstalled,
  matchPluginInstallOffer,
} from "./plugin-install";

function registryPlugin(overrides: Partial<RegistryPlugin> & Pick<RegistryPlugin, "id">): RegistryPlugin {
  return {
    name: overrides.id,
    tagline: "",
    author: { name: "Gloom", github: "gloom-sh" },
    categories: [],
    targets: ["cli", "tui", "desktop", "web"],
    hosts: [],
    contributes: { panes: [], capabilities: [], broker: false },
    tier: "official",
    bundled: false,
    stars: 0,
    ...overrides,
  };
}

const fearGreed = registryPlugin({
  id: "fear-greed",
  name: "Fear & Greed",
  repo: "gloom-sh/gloom-fear-greed",
  contributes: {
    panes: ["fear-greed"],
    capabilities: [],
    broker: false,
    shortcuts: [{ code: "FNG", name: "Fear & Greed", description: "Sentiment gauge." }],
  },
});

const predictionMarkets = registryPlugin({
  id: "prediction-markets",
  name: "Prediction Markets",
  repo: "gloom-sh/gloom-prediction-markets",
  contributes: {
    panes: ["prediction-markets"],
    capabilities: [],
    broker: false,
    shortcuts: [{ code: "PM", name: "Prediction Markets", description: "Event markets." }],
  },
});

function match(query: string, options: {
  registry?: RegistryPlugin[];
  claimed?: string[];
  installed?: string[];
} = {}) {
  const claimed = new Set(options.claimed ?? []);
  const installed = new Set(options.installed ?? []);
  return matchPluginInstallOffer({
    query,
    registry: options.registry ?? [fearGreed, predictionMarkets],
    isClaimed: (code) => claimed.has(code),
    isInstalled: (plugin) => installed.has(plugin.id),
  });
}

describe("matchPluginInstallOffer", () => {
  test("matches the whole code in any case, and as the first word with an argument after it", () => {
    expect(match("fng")?.shortcut.code).toBe("FNG");
    expect(match("  Fng  ")?.argText).toBe("");
    expect(match("FNG AAPL")).toMatchObject({ plugin: { id: "fear-greed" }, argText: "AAPL" });
    expect(match("pm  fed rate cut")).toMatchObject({ plugin: { id: "prediction-markets" }, argText: "fed rate cut" });
  });

  test("never matches part of a code or a code inside a longer word", () => {
    expect(match("FN")).toBeNull();
    expect(match("FNGX")).toBeNull();
    expect(match("AAPL FNG")).toBeNull();
    expect(match("")).toBeNull();
  });

  test("a code the app already answers to wins over the registry", () => {
    expect(match("FNG", { claimed: ["FNG"] })).toBeNull();
    expect(match("PM fed", { claimed: ["PM"] })).toBeNull();
    expect(match("FNG", { claimed: ["PM"] })?.plugin.id).toBe("fear-greed");
  });

  test("an installed plugin is not offered again", () => {
    expect(match("FNG", { installed: ["fear-greed"] })).toBeNull();
  });

  test("offers only plugins Gloom publishes from gloom-sh", () => {
    const shortcuts = [{ code: "FNG", name: "Fear & Greed", description: "" }];
    const contributes = { panes: [], capabilities: [], broker: false, shortcuts };
    const community = registryPlugin({ id: "other-fng", repo: "someone/fng", tier: "community", contributes });
    const officialElsewhere = registryPlugin({ id: "fork-fng", repo: "someone/gloom-fear-greed", contributes });
    const bundled = registryPlugin({ id: "bundled-fng", bundled: true, contributes });

    expect(match("FNG", { registry: [community] })).toBeNull();
    expect(match("FNG", { registry: [officialElsewhere] })).toBeNull();
    expect(match("FNG", { registry: [bundled] })).toBeNull();
    // A community entry claiming the code first does not hide the official one.
    expect(match("FNG", { registry: [community, fearGreed] })?.plugin.id).toBe("fear-greed");
  });

  test("reads feeds without the field, or with malformed entries, as offering nothing", () => {
    const olderFeed = registryPlugin({ id: "fear-greed", repo: "gloom-sh/gloom-fear-greed" });
    const malformed = registryPlugin({
      id: "polls",
      repo: "gloom-sh/gloom-polls",
      contributes: { panes: [], capabilities: [], broker: false, shortcuts: [null, { code: 5 }, "POLL"] as never },
    });
    const noContributes = { ...registryPlugin({ id: "tv", repo: "gloom-sh/gloom-tv" }), contributes: undefined } as never;

    expect(match("FNG", { registry: [olderFeed] })).toBeNull();
    expect(match("POLL", { registry: [malformed, noContributes] })).toBeNull();
  });
});

describe("collectClaimedShortcutCodes", () => {
  test("includes built-in prefixes and every registered plugin code, switched off or not", () => {
    const commands = [{ id: "ticker", prefix: "t", aliases: ["DES"] }] as unknown as Command[];
    const disabledTemplate: PaneTemplateDef = {
      id: "fear-greed-pane",
      paneId: "fear-greed",
      label: "Fear & Greed",
      description: "",
      shortcut: { prefix: "fng", aliases: ["CNNFG"] },
    };
    const pluginCommand = { id: "open-polls", label: "Polls", shortcut: "poll" } as CommandDef;

    const codes = collectClaimedShortcutCodes(commands, {
      paneTemplates: new Map([[disabledTemplate.id, disabledTemplate]]),
      commands: new Map([[pluginCommand.id, pluginCommand]]),
    });

    expect([...codes].sort()).toEqual(["CNNFG", "DES", "FNG", "POLL", "T"]);
  });
});

describe("isRegistryPluginInstalled", () => {
  test("counts a checkout that never reported its id, by its repository's folder", () => {
    expect(isRegistryPluginInstalled(fearGreed, [{ id: "fear-greed" }])).toBe(true);
    expect(isRegistryPluginInstalled(fearGreed, [{ id: "gloom-fear-greed", directory: "Gloom-Fear-Greed" }])).toBe(true);
    expect(isRegistryPluginInstalled(fearGreed, [{ id: "polls", directory: "gloom-polls" }])).toBe(false);
  });
});
