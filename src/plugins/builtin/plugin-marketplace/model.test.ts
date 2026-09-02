import { describe, expect, test } from "bun:test";

import {
  collectCategories,
  isInstallable,
  mergeCatalog,
  sortEntries,
  unsupportedLabel,
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
  });

  test("takes enabled state from the local catalog, not the registry", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "hackernews" })],
      installed: [installedPlugin({ id: "hackernews", enabled: false, version: "0.2.0" })],
      target: "tui",
    });

    expect(entry?.installed).toBe(true);
    expect(entry?.enabled).toBe(false);
    expect(entry?.installedVersion).toBe("0.2.0");
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
  });

  test("flags a plugin the current renderer cannot run without calling it uninstalled", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "ibkr-gateway", targets: ["cli", "tui", "desktop"] })],
      installed: [installedPlugin({ id: "ibkr-gateway" })],
      target: "web",
    });

    expect(entry?.installed).toBe(true);
    expect(entry?.unsupportedHere).toBe(true);
    expect(unsupportedLabel(entry!)).toBe("Desktop only");
  });

  test("does not flag a plugin that supports the current renderer", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "hackernews" })],
      installed: [],
      target: "web",
    });

    expect(entry?.unsupportedHere).toBe(false);
    expect(unsupportedLabel(entry!)).toBeNull();
  });

  test("surfaces a load error so a broken install is visible rather than missing", () => {
    const [entry] = mergeCatalog({
      registry: [registryPlugin({ id: "broken" })],
      installed: [installedPlugin({ id: "broken", loadError: "SyntaxError" })],
      target: "tui",
    });

    expect(entry?.loadError).toBe("SyntaxError");
  });
});

describe("sortEntries", () => {
  test("puts what is installed above the rest of the catalog", () => {
    // One list rather than two tabs: acting on what you already have should not
    // require a mode switch, and an uninstalled plugin should never outrank one
    // that is present just because it has more stars.
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "popular-uninstalled", tier: "official", stars: 5000 }),
        registryPlugin({ id: "quiet-installed", tier: "community", stars: 0 }),
      ],
      installed: [installedPlugin({ id: "quiet-installed" })],
      target: "tui",
    });

    expect(sortEntries(entries).map((entry) => entry.id))
      .toEqual(["quiet-installed", "popular-uninstalled"]);
  });

  test("puts the featured plugin first, then tier, then stars", () => {
    const entries = mergeCatalog({
      registry: [
        registryPlugin({ id: "community-popular", tier: "community", stars: 900 }),
        registryPlugin({ id: "official-quiet", tier: "official", stars: 2 }),
        registryPlugin({ id: "cloud", tier: "official", featured: true, bundled: true, stars: 0 }),
        registryPlugin({ id: "verified-mid", tier: "verified", stars: 50 }),
      ],
      installed: [],
      target: "tui",
    });

    // All uninstalled, so the curated order applies within that half.
    expect(sortEntries(entries).map((entry) => entry.id)).toEqual([
      "cloud",
      "official-quiet",
      "verified-mid",
      "community-popular",
    ]);
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

describe("isInstallable", () => {
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
  });

  test("does not offer an install without a repository to clone", () => {
    const [entry] = mergeCatalog({
      registry: [],
      installed: [installedPlugin({ id: "sideloaded" })],
      target: "tui",
    });

    expect(isInstallable(entry!)).toBe(false);
  });
});
