import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  bundleExternalPlugin,
  buildSharedModuleSource,
  PLUGIN_HOST_GLOBAL,
} from "./bundle";

/**
 * This is the seam that lets a plugin on disk run inside the desktop and
 * browser renderers, and the failure it prevents is nasty: if `react` or a
 * `gloomberb/*` module gets bundled into the plugin instead of shared with the
 * host, the plugin loads fine and then throws on its first hook, or silently
 * renders against a second copy of the theme. That is worth pinning down.
 */

function scratchPlugin(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gloom-bundle-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch", main: "index.tsx" }));
  writeFileSync(join(dir, "index.tsx"), source);
  return dir;
}

const fakeExports = async (specifier: string) => (
  specifier === "gloomberb/ui" ? ["Box", "Text"] : specifier === "react" ? ["useState"] : []
);

describe("buildSharedModuleSource", () => {
  test("re-exports each name from the host registry", () => {
    const source = buildSharedModuleSource("gloomberb/ui", ["Box", "Text"]);

    expect(source).toContain(PLUGIN_HOST_GLOBAL);
    expect(source).toContain('export const Box = mod["Box"];');
    expect(source).toContain('export const Text = mod["Text"];');
  });

  test("throws a directed error when the host registry is missing", () => {
    // A plugin bundle loaded before the host installs its modules should say so,
    // not fail later with an undefined property read deep in a render.
    const source = buildSharedModuleSource("gloomberb/ui", []);
    expect(source).toContain("was not installed before this plugin loaded");
  });

  test("skips a default export, which the module already provides", () => {
    expect(buildSharedModuleSource("react", ["default", "useState"]))
      .not.toContain("export const default");
  });
});

describe("bundleExternalPlugin", () => {
  test("shares react and gloomberb modules instead of bundling them", async () => {
    const dir = scratchPlugin(`
      import { useState } from "react";
      import { Box } from "gloomberb/ui";
      export default { id: "scratch", name: "Scratch", version: "1.0.0", useState, Box };
    `);
    const out = join(dir, "out");
    try {
      const result = await bundleExternalPlugin(dir, out, { exportNamesFor: fakeExports });
      const code = await Bun.file(result.outputPath).text();

      expect(result.shared).toEqual(["gloomberb/ui", "react"]);
      expect(code).toContain(PLUGIN_HOST_GLOBAL);
      // The giveaway that React got inlined rather than shared.
      expect(code).not.toContain("react-dom/client");
      expect(code).not.toContain("Invalid hook call");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bundles a plugin's own dependencies rather than sharing them", async () => {
    const dir = scratchPlugin(`
      import { double } from "./helper";
      export default { id: "scratch", name: "Scratch", version: "1.0.0", value: double(21) };
    `);
    writeFileSync(join(dir, "helper.ts"), "export function double(n: number) { return n * 2; }");
    const out = join(dir, "out");
    try {
      const result = await bundleExternalPlugin(dir, out, { exportNamesFor: fakeExports });
      const code = await Bun.file(result.outputPath).text();

      expect(result.shared).toEqual([]);
      expect(code).toContain("* 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a compile error against the plugin instead of throwing something opaque", async () => {
    const dir = scratchPlugin(`import { missing } from "./nope"; export default missing;`);
    try {
      await expect(bundleExternalPlugin(dir, join(dir, "out"), { exportNamesFor: fakeExports }))
        .rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a directory with no entry file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gloom-bundle-empty-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    try {
      await expect(bundleExternalPlugin(dir, join(dir, "out"))).rejects.toThrow("No plugin entry file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
