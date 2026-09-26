import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { linkHostPackages } from "./host-link";
import { pluginDirectoryNames } from "./plugin-names";

/**
 * A plugin is installed into a directory named after its repository, but
 * declares a sibling plugin by package name. Plugin repos are renaming from
 * `gloomberb-` to `gloom-` one at a time, so those two names disagree for as
 * long as the migration runs. When the link is missed the sibling's import
 * throws and the plugin fails to load, which is why this is worth pinning.
 */
describe("pluginDirectoryNames", () => {
  test("looks under both product names, declared name first", () => {
    expect(pluginDirectoryNames("gloomberb-ibkr")).toEqual(["gloomberb-ibkr", "gloom-ibkr"]);
    expect(pluginDirectoryNames("gloom-ibkr")).toEqual(["gloom-ibkr", "gloomberb-ibkr"]);
  });

  test("leaves a name that is neither alone", () => {
    expect(pluginDirectoryNames("react")).toEqual(["react"]);
  });
});

describe("linkPeerPlugins", () => {
  /** A plugins dir holding `peerDir`, plus a plugin that depends on `peerDep`. */
  function setup(peerDep: string, peerDir: string) {
    const root = mkdtempSync(join(tmpdir(), "gloom-host-link-"));
    const hostRoot = join(root, "host");
    const pluginsDir = join(root, "plugins");
    const pluginDir = join(pluginsDir, "gateway");
    mkdirSync(hostRoot, { recursive: true });
    mkdirSync(join(pluginsDir, peerDir), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "gateway", peerDependencies: { [peerDep]: ">=1.0.0" } }),
    );
    return { hostRoot, pluginsDir, pluginDir };
  }

  test("links a peer whose install directory uses the other product name", () => {
    const { hostRoot, pluginsDir, pluginDir } = setup("gloomberb-ibkr", "gloom-ibkr");

    const result = linkHostPackages(pluginDir, hostRoot, pluginsDir);

    // Named for the import specifier, pointing at the directory that exists.
    expect(result.linked).toContain("gloomberb-ibkr");
    expect(readlinkSync(join(pluginDir, "node_modules", "gloomberb-ibkr"))).toBe(
      join(pluginsDir, "gloom-ibkr"),
    );
  });

  test("links a gloom- peer, which the old prefix filter dropped", () => {
    const { hostRoot, pluginsDir, pluginDir } = setup("gloom-ibkr", "gloom-ibkr");

    const result = linkHostPackages(pluginDir, hostRoot, pluginsDir);

    expect(result.linked).toContain("gloom-ibkr");
  });

  test("skips a peer that is not installed under either name", () => {
    const { hostRoot, pluginsDir, pluginDir } = setup("gloomberb-ibkr", "unrelated");

    const result = linkHostPackages(pluginDir, hostRoot, pluginsDir);

    expect(result.linked).not.toContain("gloomberb-ibkr");
  });

  test("reports symlinks as the provider when a package root exists", () => {
    const { hostRoot, pluginsDir, pluginDir } = setup("gloom-ibkr", "gloom-ibkr");

    const result = linkHostPackages(pluginDir, hostRoot, pluginsDir);

    expect(result.provider).toBe("symlink");
    expect(result.error).toBeUndefined();
    expect(readlinkSync(join(pluginDir, "node_modules", "gloomberb"))).toBe(hostRoot);
  });
});

/**
 * The compiled terminal binary and the packaged desktop app have no Gloomberb
 * package on disk. Before the in-process resolver, this branch returned an
 * error, the install printed a warning, and every external plugin failed to
 * load with "Cannot find module 'gloomberb/utils'". The resolver itself is
 * exercised in a compiled executable in host-resolver.test.ts; here the
 * installer is stubbed because the real one rewires `react` for this process.
 */
describe("linkHostPackages without a package root", () => {
  function setup(peerDep?: string) {
    const root = mkdtempSync(join(tmpdir(), "gloom-host-link-noroot-"));
    const pluginsDir = join(root, "plugins");
    const pluginDir = join(pluginsDir, "gateway");
    mkdirSync(pluginDir, { recursive: true });
    if (peerDep) mkdirSync(join(pluginsDir, peerDep), { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "gateway", peerDependencies: peerDep ? { [peerDep]: ">=1.0.0" } : {} }),
    );
    return { pluginsDir, pluginDir };
  }

  test("hands the imports to the host process instead of failing", () => {
    const { pluginsDir, pluginDir } = setup();
    let installs = 0;

    const result = linkHostPackages(pluginDir, null, pluginsDir, { installResolver: () => { installs += 1; return true; } });

    expect(installs).toBe(1);
    expect(result.provider).toBe("process");
    expect(result.error).toBeUndefined();
    expect(result.skipped).toEqual(["gloomberb", "react"]);
    expect(existsSync(join(pluginDir, "node_modules", "gloomberb"))).toBe(false);
  });

  test("still links peer plugins, which the resolver cannot serve", () => {
    const { pluginsDir, pluginDir } = setup("gloom-ibkr");

    const result = linkHostPackages(pluginDir, null, pluginsDir, { installResolver: () => true });

    expect(result.linked).toEqual(["gloom-ibkr"]);
    expect(readlinkSync(join(pluginDir, "node_modules", "gloom-ibkr"))).toBe(join(pluginsDir, "gloom-ibkr"));
  });

  test("keeps the error when the process cannot register a resolver", () => {
    const { pluginsDir, pluginDir } = setup();

    const result = linkHostPackages(pluginDir, null, pluginsDir, { installResolver: () => false });

    expect(result.error).toBe("Could not locate the Gloomberb install.");
  });
});
