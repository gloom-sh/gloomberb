import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { EXTRACTED_PLUGINS, seedExtractedPlugins } from "./seed";
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

function withPluginsDir<T>(setup: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gloom-seed-"));
  try {
    return setup(dir);
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

    expect(installs).toEqual([]);
    // Recorded, so we stop asking rather than retrying every launch.
    expect(result.seeded).toContain("substack");
  });

  test("records a plugin that is already installed without reinstalling it", async () => {
    const installs: string[] = [];
    const result = await withPluginsDir((pluginsDir) => {
      mkdirSync(join(pluginsDir, "gloomberb-substack"), { recursive: true });
      return seedExtractedPlugins(config(), async (ref) => { installs.push(ref); }, pluginsDir);
    });

    expect(installs).toEqual([]);
    expect(result.seeded).toContain("substack");
  });

  test("retries next launch instead of recording a failed install", async () => {
    const result = await withPluginsDir((dir) => seedExtractedPlugins(config(), async () => {
      throw new Error("offline");
    }, dir));

    expect(result.failed).toContain("substack");
    expect(result.seeded).not.toContain("substack");
  });
});
