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
  return { id: "x", name: "X", version: "1.0.0", path: "/tmp/x", directory: "x", ...overrides };
}

describe("loadDesktopExternalPlugins", () => {
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

  test("keeps a terminal-only plugin apart from the broken ones", async () => {
    // IBKR Gateway declares cli and tui on purpose. Reporting that as a load
    // error made the marketplace call a working install "failed".
    const [entry] = await loadDesktopExternalPlugins([
      bundle({ id: "ibkr-gateway", targets: ["cli", "tui"], unsupportedTarget: "desktop" }),
    ]);

    expect(entry?.error).toBeUndefined();
    expect(entry?.unsupportedTarget).toBe("desktop");
    expect(entry?.plugin.targets).toEqual(["cli", "tui"]);
  });
});
