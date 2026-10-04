import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { linkHostPackages, missingPeerPlugins } from "./host-link";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A plugin is installed into a directory named after its repository, but
 * declares a sibling plugin by package name. Plugin repos are renaming from
 * `gloomberb-` to `gloom-` one at a time, so those two names disagree for as
 * long as the migration runs. When the link is missed the sibling's import
 * throws and the plugin fails to load, which is why this is worth pinning.
 */
describe("linkPeerPlugins", () => {
  /** A plugins dir holding `peerDir`, plus a plugin that depends on `peerDep`. */
  function setup(peerDep: string, peerDir: string) {
    const root = scratchDir("gloom-host-link-");
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
    expect(realpathSync(join(pluginDir, "node_modules", "gloomberb-ibkr"))).toBe(
      realpathSync(join(pluginsDir, "gloom-ibkr")),
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
    expect(realpathSync(join(pluginDir, "node_modules", "gloomberb"))).toBe(realpathSync(hostRoot));
  });

  test("links a react that a global install hoisted beside the host", () => {
    const root = scratchDir("gloom-host-link-hoisted-");
    const hostRoot = join(root, "node_modules", "gloomberb");
    const react = join(root, "node_modules", "react");
    const pluginDir = join(root, "plugins", "gloom-tv");
    mkdirSync(hostRoot, { recursive: true });
    mkdirSync(react, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(hostRoot, "package.json"), JSON.stringify({ name: "gloomberb" }));
    writeFileSync(join(react, "package.json"), JSON.stringify({ name: "react", version: "19.0.0" }));

    const result = linkHostPackages(pluginDir, hostRoot, join(root, "plugins"));

    expect(result.linked).toContain("react");
    expect(realpathSync(join(pluginDir, "node_modules", "react"))).toBe(realpathSync(react));
  });

  // Windows gets a junction here. Replacing one must remove the link itself:
  // a recursive delete through it would empty the host install.
  test("repoints a stale link without touching what it pointed at", () => {
    const { hostRoot, pluginsDir, pluginDir } = setup("gloom-ibkr", "gloom-ibkr");
    const otherHost = join(dirname(hostRoot), "other-host");
    mkdirSync(otherHost, { recursive: true });
    writeFileSync(join(hostRoot, "package.json"), "{}");

    linkHostPackages(pluginDir, hostRoot, pluginsDir);
    const result = linkHostPackages(pluginDir, otherHost, pluginsDir);

    expect(result.error).toBeUndefined();
    expect(realpathSync(join(pluginDir, "node_modules", "gloomberb"))).toBe(realpathSync(otherHost));
    expect(existsSync(join(hostRoot, "package.json"))).toBe(true);
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
    const root = scratchDir("gloom-host-link-noroot-");
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
    expect(realpathSync(join(pluginDir, "node_modules", "gloom-ibkr"))).toBe(realpathSync(join(pluginsDir, "gloom-ibkr")));
  });

  test("keeps the error when the process cannot register a resolver", () => {
    const { pluginsDir, pluginDir } = setup();

    const result = linkHostPackages(pluginDir, null, pluginsDir, { installResolver: () => false });

    expect(result.error).toBe("Could not locate the Gloomberb install.");
  });
});

describe("missingPeerPlugins", () => {
  test("names a declared sibling plugin installed under neither name", () => {
    const root = scratchDir("gloom-missing-peer-");
    const pluginsDir = join(root, "plugins");
    const gateway = join(pluginsDir, "gloom-ibkr-gateway");
    mkdirSync(gateway, { recursive: true });
    writeFileSync(join(gateway, "package.json"), JSON.stringify({
      peerDependencies: { gloomberb: ">=0.15.0", react: ">=19", "gloom-ibkr": ">=1.1.0" },
    }));

    expect(missingPeerPlugins(gateway, pluginsDir)).toEqual(["gloom-ibkr"]);
    mkdirSync(join(pluginsDir, "gloomberb-ibkr"));
    expect(missingPeerPlugins(gateway, pluginsDir)).toEqual([]);
  });
});
