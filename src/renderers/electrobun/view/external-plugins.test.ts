import { describe, expect, test } from "bun:test";

import { loadDesktopExternalPlugins } from "./external-plugins";
import type { DesktopExternalPluginBundle } from "../shared/protocol";

/**
 * The guarantee under test is containment: a plugin that fails to compile, ships
 * no bundle, or exports the wrong shape must surface as a broken entry the
 * marketplace can explain, never as an exception that stops the desktop app from
 * starting. Every case here is one a user can hit by installing a bad plugin.
 */
function bundle(overrides: Partial<DesktopExternalPluginBundle>): DesktopExternalPluginBundle {
  return { id: "x", name: "X", version: "1.0.0", path: "/tmp/x", ...overrides };
}

describe("loadDesktopExternalPlugins", () => {
  test("does nothing when there is nothing to load", async () => {
    expect(await loadDesktopExternalPlugins([])).toEqual([]);
  });

  test("carries a compile error through instead of throwing", async () => {
    const [entry] = await loadDesktopExternalPlugins([
      bundle({ id: "broken", error: "Could not resolve ./nope" }),
    ]);

    expect(entry?.error).toBe("Could not resolve ./nope");
    expect(entry?.plugin.id).toBe("broken");
  });

  test("reports a bundle that arrived without code", async () => {
    const [entry] = await loadDesktopExternalPlugins([bundle({ id: "empty" })]);

    expect(entry?.error).toContain("no bundle");
  });

  test("keeps loading the rest after one plugin fails", async () => {
    const entries = await loadDesktopExternalPlugins([
      bundle({ id: "first", error: "boom" }),
      bundle({ id: "second", error: "also boom" }),
    ]);

    expect(entries.map((entry) => entry.plugin.id)).toEqual(["first", "second"]);
    expect(entries.every((entry) => entry.error)).toBe(true);
  });
});
