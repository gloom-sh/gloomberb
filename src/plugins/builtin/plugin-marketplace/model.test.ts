import { describe, expect, test } from "bun:test";

import {
  buildRows,
  collectCategories,
  filterEntries,
  hasUpdate,
  isInstallable,
  isManaged,
  mergeCatalog,
  needsRemoteCheck,
  registryPin,
  sortEntries,
  statusOf,
  unsupportedLabel,
  versionLabel,
  type InstalledPlugin,
  type RegistryPlugin,
} from "./model";

function registryPlugin(overrides: Partial<RegistryPlugin> & Pick<RegistryPlugin, "id">): RegistryPlugin {
  return {
    name: overrides.id,
    repo: `gloom-sh/${overrides.id}`,
    tagline: "",
    author: { name: "Someone" },
    categories: ["data"],
    targets: ["cli", "tui", "desktop", "web"],
    hosts: [],
    contributes: { panes: [], capabilities: [], broker: false },
    tier: "community",
    bundled: false,
    stars: 0,
    ...overrides,
  };
}

function installedPlugin(overrides: Partial<InstalledPlugin> & Pick<InstalledPlugin, "id">): InstalledPlugin {
  return {
    name: overrides.id,
    version: "1.0.0",
    toggleable: true,
    enabled: true,
    source: "external",
    directory: overrides.id,
    ...overrides,
  };
}

/**
 * The merge is the only real logic in this pane, and it reconciles three
 * sources that disagree during normal use. Each case below is a state a user
 * can actually reach, and getting one wrong either hides a plugin they have
 * installed or offers an install button for something already present.
 */
describe("mergeCatalog", () => {
  test("marks a bundled plugin installed even when the local catalog has not reported it", () => {
    // Happens whenever the feed ships an entry before the user upgrades.
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "gloomberb-cloud", bundled: true, tier: "official" })],
      installed: [],
      target: "tui",
    });

    expect(entry?.installed).toBe(true);
    expect(entry?.enabled).toBe(true);
    expect(entry?.section).toBe("builtin");
  });

  test("takes enabled state and version from the local catalog, not the registry", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "hackernews", ref: "v0.3.0" })],
      installed: [installedPlugin({ id: "hackernews", enabled: false, version: "0.2.0" })],
      target: "tui",
    });

    expect(entry?.installed).toBe(true);
    expect(entry?.enabled).toBe(false);
    expect(entry?.installedVersion).toBe("0.2.0");
    expect(entry?.availableVersion).toBe("v0.3.0");
    expect(entry?.section).toBe("installed");
  });

  test("keeps a side-loaded plugin the registry has never seen", () => {
    const entries = mergeCatalog({
      registry: [registryPlugin({ id: "hackernews" })],
      installed: [installedPlugin({ id: "my-private-plugin" })],
      target: "tui",
    });

    const sideloaded = entries.find((entry) => entry.id === "my-private-plugin");
    expect(sideloaded?.installed).toBe(true);
    expect(sideloaded?.categories).toEqual(["unlisted"]);
    expect(sideloaded?.section).toBe("installed");
  });

  test("flags a plugin the current renderer cannot run without calling it uninstalled", () => {
    // The loader reports the mismatch from the installed code's own targets.
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "ibkr-gateway", targets: ["cli", "tui", "desktop"] })],
      installed: [installedPlugin({ id: "ibkr-gateway", unsupportedTarget: "web" })],
      target: "web",
    });

    expect(entry?.installed).toBe(true);
    expect(entry?.unsupportedHere).toBe(true);
    expect(unsupportedLabel(entry!)).toBe("Not on web");
  });

  test("believes a plugin that loaded here over a feed that says it should not have", () => {
    // The installed code declares desktop; the feed is a release behind and
    // still lists cli and tui. The pane was calling a running plugin
    // "terminal only".
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "ibkr-gateway", targets: ["cli", "tui"] })],
      installed: [installedPlugin({ id: "ibkr-gateway" })],
      target: "desktop",
    });

    expect(entry?.unsupportedHere).toBe(false);
    expect(statusOf(entry!).kind).toBe("enabled");
  });

  test("names the one renderer a plugin is limited to", () => {
    const [desktopOnly, terminalOnly] = mergeCatalog({
      registry: [
        registryPlugin({ id: "native-charts", targets: ["desktop"] }),
        registryPlugin({ id: "ibkr-gateway", targets: ["cli", "tui"] }),
      ],
      installed: [],
      target: "web",
    });

    expect(unsupportedLabel(desktopOnly!)).toBe("Desktop only");
    expect(unsupportedLabel(terminalOnly!)).toBe("Terminal only");
  });

  test("flags an external plugin the web app did not compile in, whatever it declares", () => {
    // term.gloom.sh installs nothing. A plugin that lists "web" in its targets
    // is describing where its code could run, not where the web app will load it
    // from, so until the build carries it, it must not look installable.
    const [external, bundled] = mergeCatalog({
      registry: [
        registryPlugin({ id: "hackernews", targets: ["cli", "tui", "desktop", "web"] }),
        registryPlugin({ id: "portfolio", bundled: true, targets: ["cli", "tui", "desktop", "web"] }),
      ],
      installed: [],
      target: "web",
    });

    expect(external?.unsupportedHere).toBe(true);
    expect(unsupportedLabel(external!)).toBe("Not on web");
    expect(bundled?.unsupportedHere).toBe(false);
  });

  test("treats a plugin compiled into the web build as running here", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "polls", targets: ["cli", "tui", "desktop", "web"] })],
      installed: [installedPlugin({ id: "polls" })],
      target: "web",
    });

    expect(entry?.installed).toBe(true);
    expect(entry?.unsupportedHere).toBe(false);
    expect(isInstallable(entry!)).toBe(false);
  });

  test("surfaces a load error so a broken install is visible rather than missing", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "broken" })],
      installed: [installedPlugin({ id: "broken", loadError: "SyntaxError" })],
      target: "tui",
    });

    expect(entry?.loadError).toBe("SyntaxError");
    expect(statusOf(entry!).kind).toBe("failed");
  });

  test("puts a failed import on the registry row it was installed from", () => {
    // The loader cannot read an id from a module that does not evaluate, so it
    // reports the folder. Left unmatched, the user sees the plugin they just
    // installed as still available, plus an unlisted "gloomberb-adjacent" that
    // failed: two rows for one broken install.
    const entries = mergeCatalog({
      registry: [registryPlugin({ id: "adjacent-indices", repo: "Lucas-Kohorst/gloomberb-adjacent" })],
      installed: [installedPlugin({
        id: "gloomberb-adjacent",
        name: "gloomberb-adjacent",
        version: "",
        directory: "gloomberb-adjacent",
        loadError: "Cannot find module 'gloomberb/plugins'",
      })],
      target: "tui",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("adjacent-indices");
    expect(entries[0]?.installed).toBe(true);
    expect(entries[0]?.directory).toBe("gloomberb-adjacent");
    expect(statusOf(entries[0]!).kind).toBe("failed");
    expect(versionLabel(entries[0]!)).toBe("");
  });

  test("matches by id before folder, so a shared folder name cannot steal a plugin that reports its id", () => {
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "fork", repo: "someone/gloom-thing" }),
        registryPlugin({ id: "thing", repo: "gloom-sh/gloom-thing" }),
      ],
      installed: [installedPlugin({ id: "thing", directory: "gloom-thing" })],
      target: "tui",
    });

    expect(entries.find((entry) => entry.id === "thing")?.installed).toBe(true);
    expect(entries.find((entry) => entry.id === "fork")?.installed).toBe(false);
  });
});

/**
 * The update check reads two different signals depending on what the registry
 * and the checkout expose. Getting the precedence wrong either nags a user
 * who is current or hides a real update behind a matching version string.
 */
describe("hasUpdate", () => {
  test("compares versions when both sides have one", () => {
    const [behind, current] = mergeCatalog({
      registry: [
        registryPlugin({ id: "a", ref: "v1.3.0", commit: "aaaaaaa" }),
        registryPlugin({ id: "b", ref: "v1.3.0", commit: "bbbbbbb" }),
      ],
      installed: [
        installedPlugin({ id: "a", version: "1.2.9", commit: "0000000" }),
        installedPlugin({ id: "b", version: "1.3.0", commit: "0000000" }),
      ],
      target: "tui",
    });

    expect(hasUpdate(behind!)).toBe(true);
    expect(versionLabel(behind!)).toBe("1.2.9 → 1.3.0");
    // Same version from a different commit: the version is what was published,
    // so trust it rather than asking the user to re-pull.
    expect(hasUpdate(current!)).toBe(false);
    expect(versionLabel(current!)).toBe("1.3.0");
  });

  test("falls back to the reviewed commit when the registry pins one without a version", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "a", commit: "abc1234def" })],
      installed: [installedPlugin({ id: "a", version: "1.0.0", commit: "abc1234def0000000000000000000000000000000" })],
      target: "tui",
    });

    expect(hasUpdate(entry!)).toBe(false);

    const [moved] = mergeCatalog({
      registry: [registryPlugin({ id: "a", commit: "fffffff" })],
      installed: [installedPlugin({ id: "a", version: "1.0.0", commit: "abc1234def0000000000000000000000000000000" })],
      target: "tui",
    });
    expect(hasUpdate(moved!)).toBe(true);
    expect(statusOf(moved!).kind).toBe("update");
  });

  test("never marks a linked dev checkout as behind", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "a", ref: "v9.0.0" })],
      installed: [installedPlugin({ id: "a", version: "0.1.0", linked: true })],
      target: "tui",
    });

    expect(hasUpdate(entry!)).toBe(false);
  });

  test("compares an unlisted plugin against its own remote", () => {
    // Nothing in the registry to pin it, so the default branch is the answer,
    // which is where `update` would land it.
    const [behind] = mergeCatalog({
      registry: [],
      installed: [installedPlugin({ id: "social", directory: "gloomberb-social", commit: "1111111aaa" })],
      remoteHeads: { "gloomberb-social": "2222222bbb" },
      target: "desktop",
    });
    expect(behind!.remoteCommit).toBe("2222222bbb");
    expect(hasUpdate(behind!)).toBe(true);
    expect(versionLabel(behind!)).toBe("1.0.0 → 2222222");
    expect(statusOf(behind!).kind).toBe("update");

    const [current] = mergeCatalog({
      registry: [],
      installed: [installedPlugin({ id: "social", directory: "gloomberb-social", commit: "2222222bbb0000000000" })],
      remoteHeads: { "gloomberb-social": "2222222bbb" },
      target: "desktop",
    });
    expect(hasUpdate(current!)).toBe(false);
  });

  test("leaves a registry-pinned plugin on the reviewed commit, whatever its branch holds", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "a", commit: "abc1234" })],
      installed: [installedPlugin({ id: "a", commit: "abc1234000" })],
      remoteHeads: { a: "9999999" },
      target: "tui",
    });

    expect(hasUpdate(entry!)).toBe(false);
  });

  test("says nothing until the remote has answered", () => {
    const [entry] = mergeCatalog({
      registry: [],
      installed: [installedPlugin({ id: "social", directory: "gloomberb-social", commit: "1111111" })],
      target: "desktop",
    });

    expect(hasUpdate(entry!)).toBe(false);
    expect(versionLabel(entry!)).toBe("1.0.0");
  });
});

describe("needsRemoteCheck", () => {
  test("asks only for installed clones the registry does not pin", () => {
    const [listed, unlisted, linked] = mergeCatalog({
      registry: [registryPlugin({ id: "listed", ref: "v1.0.0" })],
      installed: [
        installedPlugin({ id: "listed" }),
        installedPlugin({ id: "unlisted", directory: "gloomberb-social" }),
        installedPlugin({ id: "linked", directory: "dev", linked: true }),
      ],
      target: "desktop",
    });

    expect(needsRemoteCheck(listed!)).toBe(false);
    expect(needsRemoteCheck(unlisted!)).toBe(true);
    expect(needsRemoteCheck(linked!)).toBe(false);
  });

  test("leaves built-ins alone", () => {
    const [builtin] = mergeCatalog({
      registry: [registryPlugin({ id: "portfolio", bundled: true })],
      installed: [installedPlugin({ id: "portfolio", source: "builtin", directory: undefined })],
      target: "tui",
    });

    expect(needsRemoteCheck(builtin!)).toBe(false);
  });
});

describe("statusOf", () => {
  test("ranks health above state", () => {
    const [failedButEnabled, disabledWithUpdate, needsSetup, erroring] = mergeCatalog({
      registry: [
        registryPlugin({ id: "a", ref: "v2.0.0" }),
        registryPlugin({ id: "b", ref: "v2.0.0" }),
        registryPlugin({ id: "c" }),
        registryPlugin({ id: "d" }),
      ],
      installed: [
        installedPlugin({ id: "a", version: "1.0.0", loadError: "boom" }),
        installedPlugin({ id: "b", version: "1.0.0", enabled: false }),
        installedPlugin({ id: "c", hasSetup: true, needsSetup: true }),
        installedPlugin({ id: "d", errorCount: 3, lastError: "timeout" }),
      ],
      target: "tui",
    });

    expect(statusOf(failedButEnabled!).kind).toBe("failed");
    // Off is off; there is nothing to update until it is turned back on.
    expect(statusOf(disabledWithUpdate!).kind).toBe("disabled");
    expect(statusOf(needsSetup!).kind).toBe("needs-setup");
    expect(statusOf(erroring!)).toEqual({ kind: "errors", text: "errors (3)" });
  });

  test("says which Gloomberb an install or update needs when this build is older", () => {
    const [outdated, notInstalled, current, untouched] = mergeCatalog({
      registry: [
        registryPlugin({ id: "a", commit: "fffffff", minGloomberb: "999.0.0" }),
        registryPlugin({ id: "b", minGloomberb: "v999.1.0" }),
        registryPlugin({ id: "c", commit: "fffffff", minGloomberb: "0.1.0" }),
        registryPlugin({ id: "d", commit: "abc1234", minGloomberb: "999.0.0" }),
      ],
      installed: [
        installedPlugin({ id: "a", commit: "abc1234" }),
        installedPlugin({ id: "c", commit: "abc1234" }),
        installedPlugin({ id: "d", commit: "abc1234" }),
      ],
      target: "tui",
    });

    // The update would land code this build cannot compile.
    expect(statusOf(outdated!)).toEqual({ kind: "needs-gloomberb", text: "needs 999.0.0" });
    expect(statusOf(notInstalled!)).toEqual({ kind: "needs-gloomberb", text: "needs 999.1.0" });
    expect(statusOf(current!).kind).toBe("update");
    // Already on that commit: the requirement says nothing about what to do.
    expect(statusOf(untouched!).kind).toBe("enabled");
  });
});

describe("sortEntries and buildRows", () => {
  test("groups installed, then available, then built in, with headers", () => {
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "popular-uninstalled", tier: "official", stars: 5000 }),
        registryPlugin({ id: "quiet-installed", tier: "community", stars: 0 }),
        registryPlugin({ id: "cloud", tier: "official", featured: true, bundled: true }),
      ],
      installed: [installedPlugin({ id: "quiet-installed" })],
      target: "tui",
    });

    const sorted = sortEntries(entries);
    expect(sorted.map((entry) => entry.id)).toEqual(["quiet-installed", "popular-uninstalled", "cloud"]);
    expect(buildRows(sorted).map((row) => (row.type === "header" ? `#${row.section}:${row.count}` : row.entry.id)))
      .toEqual(["#installed:1", "quiet-installed", "#available:1", "popular-uninstalled", "#builtin:1", "cloud"]);
  });

  test("keeps the curated order inside a section: featured, tier, stars", () => {
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "community-popular", tier: "community", stars: 900 }),
        registryPlugin({ id: "official-quiet", tier: "official", stars: 2 }),
        registryPlugin({ id: "featured", tier: "verified", featured: true, stars: 0 }),
        registryPlugin({ id: "verified-mid", tier: "verified", stars: 50 }),
      ],
      installed: [],
      target: "tui",
    });

    expect(sortEntries(entries).map((entry) => entry.id)).toEqual([
      "featured",
      "official-quiet",
      "verified-mid",
      "community-popular",
    ]);
  });
});

describe("filterEntries", () => {
  test("hides built-in modules unless asked, and never shows ones without a switch", () => {
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "hackernews" }),
        registryPlugin({ id: "cloud", bundled: true }),
        registryPlugin({ id: "application", bundled: true }),
      ],
      installed: [
        installedPlugin({ id: "cloud", source: "builtin", directory: undefined }),
        installedPlugin({ id: "application", source: "builtin", directory: undefined, toggleable: false }),
      ],
      target: "tui",
    });

    expect(filterEntries(entries, { query: "", category: null, showBuiltin: false }).map((entry) => entry.id))
      .toEqual(["hackernews"]);
    expect(filterEntries(entries, { query: "", category: null, showBuiltin: true }).map((entry) => entry.id))
      .toEqual(["hackernews", "cloud"]);
  });
});

describe("collectCategories", () => {
  test("deduplicates and sorts categories across the catalog", () => {
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "a", categories: ["news", "data"] }),
        registryPlugin({ id: "b", categories: ["data"] }),
      ],
      installed: [],
      target: "tui",
    });

    expect(collectCategories(entries)).toEqual(["data", "news"]);
  });
});

describe("isInstallable and isManaged", () => {
  test("offers an install only for a catalog plugin that is absent", () => {
    const [available, bundled, installed] = mergeCatalog({
      registry: [
        registryPlugin({ id: "available" }),
        registryPlugin({ id: "bundled", bundled: true }),
        registryPlugin({ id: "installed" }),
      ],
      installed: [installedPlugin({ id: "installed" })],
      target: "tui",
    });

    expect(isInstallable(available!)).toBe(true);
    // Ships with the app; there is nothing to fetch.
    expect(isInstallable(bundled!)).toBe(false);
    expect(isInstallable(installed!)).toBe(false);
    expect(isManaged(installed!)).toBe(true);
    expect(isManaged(bundled!)).toBe(false);
  });

  test("does not offer an install without a repository to clone", () => {
    const [entry] = mergeCatalog({
      registry: [],
      installed: [installedPlugin({ id: "sideloaded" })],
      target: "tui",
    });

    expect(isInstallable(entry!)).toBe(false);
  });

  test("passes the registry pin through so an install lands on the reviewed commit", () => {
    const [pinned, unpinned] = mergeCatalog({
      registry: [
        registryPlugin({ id: "pinned", ref: "v1.2.0", commit: "abcdef0" }),
        registryPlugin({ id: "unpinned" }),
      ],
      installed: [],
      target: "tui",
    });

    expect(registryPin(pinned!)).toEqual({ ref: "v1.2.0", commit: "abcdef0" });
    expect(registryPin(unpinned!)).toBeUndefined();
  });
});
