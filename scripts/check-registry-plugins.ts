import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadRegistry } from "../src/plugins/builtin/plugin-marketplace/feed";
import { PluginBundleError, bundleExternalPlugin } from "../src/plugins/bundle";
import { findMissingHostExport } from "../src/plugins/compat";
import { linkHostPackages } from "../src/plugins/host-link";
import { resolvePluginBrowserEntry, resolvePluginEntry } from "../src/plugins/loader";

/**
 * Compiles every plugin the registry lists against this checkout, the way the
 * desktop compiles one from disk, and fails when a plugin imports a host
 * export that does not exist here. A change that drops or renames a public
 * export some published plugin still uses fails in CI rather than in the
 * installs of everyone who updates Gloomberb before the plugin.
 *
 * Each plugin is checked at its registry ref, or its default branch when the
 * registry does not pin it: what `gloomberb install` would land. Anything
 * else that goes wrong (the registry or GitHub unreachable, a dependency of
 * the plugin's own that does not resolve) is reported as a warning. This job
 * judges the host, not the plugins.
 */

const annotate = (level: "error" | "warning", message: string) => {
  console.log(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level}: ${message}`);
};

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

const feed = await loadRegistry();
const listed = feed.plugins.filter((plugin) => plugin.repo && !plugin.bundled);
if (listed.length === 0) {
  annotate("warning", `No registry plugins to check${feed.error ? `: ${feed.error}` : ""}.`);
  process.exit(0);
}

// One folder for all of them, named like the installer names them, so a
// plugin that builds on another (Gateway on IBKR) finds it the same way.
const pluginsDir = mkdtempSync(join(tmpdir(), "gloom-registry-plugins-"));
const failures: string[] = [];

try {
  const cloned: Array<{ id: string; dir: string }> = [];
  for (const plugin of listed) {
    const dir = join(pluginsDir, plugin.repo!.split("/")[1]!);
    try {
      run("git", ["clone", "--quiet", "--depth", "1", ...(plugin.ref ? ["--branch", plugin.ref] : []), `https://github.com/${plugin.repo}.git`, dir], pluginsDir);
      cloned.push({ id: plugin.id, dir });
    } catch (error) {
      annotate("warning", `${plugin.id}: could not clone ${plugin.repo}${plugin.ref ? ` at ${plugin.ref}` : ""}: ${error}`);
    }
  }

  for (const { id, dir } of cloned) {
    try {
      // Peers are the host and sibling plugins, which are linked below.
      run("bun", ["install", "--production", "--omit", "peer", "--ignore-scripts"], dir);
    } catch (error) {
      annotate("warning", `${id}: bun install failed: ${error}`);
    }
    linkHostPackages(dir, undefined, pluginsDir);
  }

  for (const { id, dir } of cloned) {
    const nativeEntry = await resolvePluginEntry(dir);
    // The terminal imports the native entry; the desktop and web compile the
    // browser one. Both, when a plugin ships two.
    const targets: Array<"browser" | "bun"> = nativeEntry && nativeEntry !== await resolvePluginBrowserEntry(dir)
      ? ["browser", "bun"]
      : ["browser"];
    for (const target of targets) {
      try {
        await bundleExternalPlugin(dir, join(pluginsDir, ".out", id, target), {
          target,
          define: { "process.env.NODE_ENV": "\"production\"" },
        });
      } catch (error) {
        const causes = error instanceof PluginBundleError ? error.causes : [String(error)];
        const missing = causes.flatMap((cause) => findMissingHostExport(cause) ?? []);
        for (const { name, specifier } of missing) {
          failures.push(`${id} (${target} entry) imports ${name} from ${specifier}, which this checkout does not export.`);
        }
        if (missing.length === 0) annotate("warning", `${id} (${target} entry) did not compile: ${causes[0]}`);
      }
    }
    console.log(`checked ${id}`);
  }
} finally {
  rmSync(pluginsDir, { recursive: true, force: true });
}

for (const failure of failures) annotate("error", failure);
if (failures.length > 0) {
  console.log(`\n${failures.length} import${failures.length === 1 ? "" : "s"} of host exports this checkout does not have. See the policy in PLUGINS.md.`);
  process.exit(1);
}
console.log(`\nEvery registry plugin's host imports resolve (${listed.length} listed).`);
