import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { EXTRACTED_PLUGINS, officialPluginsCheck, pluginSeedFailure, pluginSeedNotice, seedExtractedPlugins } from "./extracted-plugins";
import type { AppConfig } from "../types/config";

/**
 * Extracting a built-in plugin is the one change here that can quietly take a
 * working feature away from an existing user, so the seeding rules are worth
 * pinning: restore it once, never fight a deliberate removal, and never record
 * a failure as done — being offline at startup is common, and marking it seeded
 * would drop the plugin permanently.
 */
function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { disabledPlugins: [], seededPlugins: [], ...overrides } as AppConfig;
}

async function withPluginsDir<T>(setup: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gloom-seed-"));
  try {
    return await setup(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("seedExtractedPlugins", () => {
  test("installs an extracted plugin the user has not seen", async () => {
    const installs: string[] = [];
    const result = await withPluginsDir((dir) => seedExtractedPlugins(config(), async (ref) => {
      installs.push(ref);
    }, dir));

    expect(installs).toEqual(EXTRACTED_PLUGINS.map((entry) => entry.repo));
    expect(result.installed).toEqual(EXTRACTED_PLUGINS.map((entry) => entry.id));
    expect(result.seeded).toEqual(EXTRACTED_PLUGINS.map((entry) => entry.id));
  });

  test("does nothing once a plugin has been seeded", async () => {
    const installs: string[] = [];
    const seeded = EXTRACTED_PLUGINS.map((entry) => entry.id);
    await withPluginsDir((dir) => seedExtractedPlugins(config({ seededPlugins: seeded }), async (ref) => {
      installs.push(ref);
    }, dir));

    expect(installs).toEqual([]);
  });

  test("respects a plugin the user disabled before the move", async () => {
    const installs: string[] = [];
    const result = await withPluginsDir((dir) => seedExtractedPlugins(
      config({ disabledPlugins: ["substack"] }),
      async (ref) => { installs.push(ref); },
      dir,
    ));

    expect(installs).not.toContain("gloom-sh/gloom-substack");
    // Recorded, so we stop asking rather than retrying every launch.
    expect(result.seeded).toContain("substack");
  });

  test("records a plugin that is already installed without reinstalling it", async () => {
    const installs: string[] = [];
    const result = await withPluginsDir((pluginsDir) => {
      mkdirSync(join(pluginsDir, "gloom-substack"), { recursive: true });
      return seedExtractedPlugins(config(), async (ref) => { installs.push(ref); }, pluginsDir);
    });

    expect(installs).not.toContain("gloom-sh/gloom-substack");
    expect(result.seeded).toContain("substack");
  });

  /**
   * The plugin repositories are renaming to `gloom-`, so anyone who installed
   * one before the rename has it in a directory under the old name. Seeding by
   * the new name alone would clone a second copy, and the loader then refuses
   * both for sharing an id.
   */
  test("finds an install made before the repository was renamed", async () => {
    const installs: string[] = [];
    const result = await withPluginsDir((pluginsDir) => {
      mkdirSync(join(pluginsDir, "gloomberb-substack"), { recursive: true });
      return seedExtractedPlugins(config(), async (ref) => { installs.push(ref); }, pluginsDir);
    });

    expect(installs).not.toContain("gloom-sh/gloom-substack");
    expect(result.seeded).toContain("substack");
  });

  /**
   * TV was a module inside Macro, so turning that plugin off was the only way
   * to turn it off. Restoring it as its own plugin would put panes back that
   * the user had removed.
   */
  test.each([
    ["macro", ["tv"]],
    ["macro-tv", ["tv"]],
    ["tv", ["tv"]],
  ] as const)("keeps extracted modules disabled when %s was disabled", async (owner, extracted) => {
    const installs: string[] = [];
    const result = await withPluginsDir((dir) => seedExtractedPlugins(
      config({ disabledPlugins: [owner] }), async (ref) => { installs.push(ref); }, dir,
    ));

    for (const id of extracted) {
      const entry = EXTRACTED_PLUGINS.find((candidate) => candidate.id === id)!;
      expect(installs).not.toContain(entry.repo);
      // Recorded, so it is not offered again on every launch.
      expect(result.seeded).toContain(id);
    }
  });

  test("counts Macro as off only while all three of its successors are", async () => {
    const tvRepo = EXTRACTED_PLUGINS.find((candidate) => candidate.id === "tv")!.repo;
    for (const [disabledPlugins, restored] of [
      [["rates-macro", "credit", "earnings"], false],
      [["credit"], true],
    ] as const) {
      const installs: string[] = [];
      await withPluginsDir((dir) => seedExtractedPlugins(
        config({ disabledPlugins: [...disabledPlugins] }), async (ref) => { installs.push(ref); }, dir,
      ));
      expect(installs.includes(tvRepo)).toBe(restored);
    }
  });

  test("retries next launch instead of recording a failed install", async () => {
    const result = await withPluginsDir((dir) => seedExtractedPlugins(config(), async () => {
      throw new Error("offline");
    }, dir));

    expect(result.failed).toContain("substack");
    expect(result.seeded).not.toContain("substack");
  });
});

/**
 * Without git every seed install fails, and the launch used to say nothing:
 * the plugins were just absent. The notice and `doctor` have to name the cause
 * and the fix, without nagging about a failure the next launch retries on its
 * own, and without failing `doctor` where no launch ever tried.
 */
describe("a seed that left official plugins out", () => {
  const all = EXTRACTED_PLUGINS.map((entry) => entry.id);

  test("a missing git is an error at every launch, Git for Windows on Windows", () => {
    const noGit = pluginSeedFailure(["polls"], true);
    expect(pluginSeedNotice(noGit, undefined, "win32")).toEqual({ type: "error", body: "Polls needs Git and is not installed. Install Git for Windows, then restart Gloom." });
    expect(pluginSeedNotice(noGit, noGit, "win32")?.type).toBe("error");
    expect(pluginSeedNotice(pluginSeedFailure(all, true), undefined, "linux")?.body)
      .toBe(`${EXTRACTED_PLUGINS.length} official plugins need Git and are not installed. Install git, then restart Gloom.`);
    expect(pluginSeedNotice(undefined, noGit, "win32")).toBeNull();
  });

  test("a failure the next launch retries is information, said once while the same plugins keep failing", () => {
    const offline = pluginSeedFailure(["polls", "tv"], false);
    expect(pluginSeedNotice(offline, undefined, "linux")).toEqual({ type: "info", body: "TV and Polls could not be installed. Gloom tries again at the next launch." });
    expect(pluginSeedNotice(offline, pluginSeedFailure(["tv", "polls"], false), "linux")).toBeNull();
    // Something else failing, or git now there, is news.
    expect(pluginSeedNotice(offline, pluginSeedFailure(["tv"], false), "linux")?.type).toBe("info");
    expect(pluginSeedNotice(offline, pluginSeedFailure(["polls", "tv"], true), "linux")?.type).toBe("info");
  });

  test("doctor fails only once a launch tried, names the plugins, and passes once they are installed", async () => {
    await withPluginsDir((dir) => {
      const seeded = all.filter((id) => id !== "polls" && id !== "tv");
      const tried = config({ seededPlugins: seeded, pluginSeedFailure: pluginSeedFailure(["polls", "tv"], true) });
      expect(officialPluginsCheck(tried, { gitMissing: () => true, pluginsDir: dir, platform: "win32" })).toEqual({
        check: "official plugins",
        status: "error",
        detail: "Not installed: TV and Polls. They need Git: install Git for Windows (https://git-scm.com/download/win), then restart Gloom.",
      });

      // No launch has tried: a terminal-only setup or a container without git.
      const untried = officialPluginsCheck(config({ seededPlugins: seeded }), { gitMissing: () => true, pluginsDir: dir, platform: "linux" });
      expect(untried).toEqual({
        check: "official plugins",
        status: "warn",
        detail: "Not installed yet: TV and Polls. Gloom installs them when the app starts, which needs Git: install git.",
      });

      mkdirSync(join(dir, "gloom-polls"));
      mkdirSync(join(dir, "gloom-tv"));
      expect(officialPluginsCheck(tried, { gitMissing: () => true, pluginsDir: dir })).toBeNull();
    });
  });
});
