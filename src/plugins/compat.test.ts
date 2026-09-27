import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { checkPluginCompatibility, explainPluginLoadError, findMissingHostExport } from "./compat";
import { hostPublicModules } from "./host-link";

const scratch: string[] = [];

function plugin(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "gloom-compat-"));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The loader tests cover the refusal from each source. What is left is which
 * source wins, and that a range this check cannot read never blocks a plugin.
 */
describe("checkPluginCompatibility", () => {
  test("takes gloom.json over package.json, and ignores what does not parse", () => {
    const declared = plugin({
      "gloom.json": { minGloom: "0.14.0" },
      "package.json": { peerDependencies: { gloomberb: ">=0.16.0" } },
    });
    expect(checkPluginCompatibility(declared, "0.15.2")).toBeNull();

    const unparseable = plugin({
      "gloom.json": { minGloom: "latest" },
      "package.json": { peerDependencies: { gloomberb: "^0.16.0 || >=1.0.0" } },
    });
    expect(checkPluginCompatibility(unparseable, "0.15.2")).toBeNull();
  });
});

/**
 * Bun words a missing export differently for a native import and for the
 * bundler, and names the module by path, by specifier or by the bundler's
 * namespace. Each of those has to land on the public specifier a plugin
 * author wrote, or the user gets Bun's message about a file they never saw.
 * The loader and bundle tests run the real Bun for the path forms; these pin
 * the shapes those cannot reach.
 */
describe("findMissingHostExport", () => {
  const componentsFile = () => hostPublicModules().get("gloomberb/components")!;

  test("maps a native import error on a host file to its specifier", () => {
    expect(findMissingHostExport(`Export named 'OldTable' not found in module '${componentsFile()}'.`))
      .toEqual({ specifier: "gloomberb/components", name: "OldTable" });
  });

  test("reads the specifier the packaged host serves", () => {
    expect(findMissingHostExport("Export named 'httpGet' not found in module 'gloomberb/utils'."))
      .toEqual({ specifier: "gloomberb/utils", name: "httpGet" });
  });

  test("maps the bundler's namespace and working-directory paths", () => {
    expect(findMissingHostExport('No matching export in "gloom-host:gloomberb/ui" for import "QueryBar"'))
      .toEqual({ specifier: "gloomberb/ui", name: "QueryBar" });
    const layout = relative(process.cwd(), hostPublicModules().get("gloomberb/layout")!);
    expect(findMissingHostExport(`No matching export in "${layout}" for import "openPane"`))
      .toEqual({ specifier: "gloomberb/layout", name: "openPane" });
  });

  test("leaves a plugin's own files and other failures alone", () => {
    const own = "Export named 'helper' not found in module '/home/me/.gloomberb/plugins/x/util.ts'.";
    expect(findMissingHostExport(own)).toBeNull();
    expect(explainPluginLoadError(own)).toBe(own);
    expect(explainPluginLoadError("Cannot find module 'zod'")).toBe("Cannot find module 'zod'");
  });
});
