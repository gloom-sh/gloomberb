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

const polls = registryPlugin({
  id: "polls",
  name: "Polls",
  repo: "gloom-sh/gloom-polls",
  contributes: {
    panes: ["polls"],
    capabilities: [],
    broker: false,
    shortcuts: [{ code: "POLL", name: "Polls", description: "Political polls by race." }],
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
    registry: options.registry ?? [polls, predictionMarkets],
    isClaimed: (code) => claimed.has(code),
    isInstalled: (plugin) => installed.has(plugin.id),
  });
}

describe("matchPluginInstallOffer", () => {
  test("matches the whole code in any case, and as the first word with an argument after it", () => {
    expect(match("poll")?.shortcut.code).toBe("POLL");
    expect(match("  Poll  ")?.argText).toBe("");
    expect(match("POLL senate")).toMatchObject({ plugin: { id: "polls" }, argText: "senate" });
    expect(match("pm  fed rate cut")).toMatchObject({ plugin: { id: "prediction-markets" }, argText: "fed rate cut" });
  });

  test("never matches part of a code or a code inside a longer word", () => {
    expect(match("POL")).toBeNull();
    expect(match("POLLS")).toBeNull();
    expect(match("AAPL POLL")).toBeNull();
    expect(match("")).toBeNull();
  });

  test("a code the app already answers to wins over the registry", () => {
    expect(match("POLL", { claimed: ["POLL"] })).toBeNull();
    expect(match("PM fed", { claimed: ["PM"] })).toBeNull();
    expect(match("POLL", { claimed: ["PM"] })?.plugin.id).toBe("polls");
  });

  test("an installed plugin is not offered again", () => {
    expect(match("POLL", { installed: ["polls"] })).toBeNull();
  });

  /**
   * Fear & Greed, Market Heatmap, Market Halts and the IPO Calendar are built
   * in again, and a feed can still list their repositories as plugins to
   * install. The installer refuses them, so not even a code nothing claims
   * offers one.
   */
  test("never offers a plugin that is built in now, whatever the feed says", () => {
    const codes = [["fear-greed", "FNG"], ["market-heatmap", "HM"], ["market-halts", "HALT"], ["ipo-calendar", "IPO"]] as const;
    const absorbed = codes.map(([id, code]) => registryPlugin({
      id,
      repo: `gloom-sh/gloom-${id}`,
      contributes: { panes: [id], capabilities: [], broker: false, shortcuts: [{ code, name: id, description: "" }] },
    }));

    for (const [, code] of codes) expect(match(code, { registry: absorbed })).toBeNull();
  });

  test("offers only plugins Gloom publishes from gloom-sh", () => {
    const shortcuts = [{ code: "POLL", name: "Polls", description: "" }];
    const contributes = { panes: [], capabilities: [], broker: false, shortcuts };
    const community = registryPlugin({ id: "other-polls", repo: "someone/polls", tier: "community", contributes });
    const officialElsewhere = registryPlugin({ id: "fork-polls", repo: "someone/gloom-polls", contributes });
    const bundled = registryPlugin({ id: "bundled-polls", bundled: true, contributes });

    expect(match("POLL", { registry: [community] })).toBeNull();
    expect(match("POLL", { registry: [officialElsewhere] })).toBeNull();
    expect(match("POLL", { registry: [bundled] })).toBeNull();
    // A community entry claiming the code first does not hide the official one.
    expect(match("POLL", { registry: [community, polls] })?.plugin.id).toBe("polls");
  });

  test("reads feeds without the field, or with malformed entries, as offering nothing", () => {
    const olderFeed = registryPlugin({ id: "polls", repo: "gloom-sh/gloom-polls" });
    const malformed = registryPlugin({
      id: "polls",
      repo: "gloom-sh/gloom-polls",
      contributes: { panes: [], capabilities: [], broker: false, shortcuts: [null, { code: 5 }, "POLL"] as never },
    });
    const noContributes = { ...registryPlugin({ id: "tv", repo: "gloom-sh/gloom-tv" }), contributes: undefined } as never;

    expect(match("POLL", { registry: [olderFeed] })).toBeNull();
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
    expect(isRegistryPluginInstalled(polls, [{ id: "polls" }])).toBe(true);
    expect(isRegistryPluginInstalled(polls, [{ id: "gloom-polls", directory: "Gloom-Polls" }])).toBe(true);
    expect(isRegistryPluginInstalled(polls, [{ id: "tv", directory: "gloom-tv" }])).toBe(false);
  });
});
