import { join } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { getPluginsDir } from "../../plugins/loader";
import { linkHostPackages } from "../../plugins/host-link";
import {
  cliStyles,
  renderSection,
  renderStat,
  renderTable,
} from "../../utils/cli-output";
import { fail } from "../errors";

const PLUGINS_DIR = getPluginsDir();

function ensurePluginsDir() {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validatePluginDirectoryName(name: string): string {
  if (!GITHUB_SEGMENT_PATTERN.test(name)) {
    throw new Error(`Invalid plugin name: ${name}.`);
  }
  return name;
}

function parseGitHubRef(rawRef: string): { url: string; name: string } {
  const ref = rawRef.startsWith("github:") ? rawRef.slice("github:".length) : rawRef;
  let segments: string[];
  if (ref.startsWith("https://")) {
    const parsed = new URL(ref);
    if (parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`Invalid plugin reference: ${rawRef}. Use user/repo or a GitHub URL.`);
    }
    segments = parsed.pathname.split("/").filter(Boolean);
  } else if (!ref.includes("://")) {
    segments = ref.split("/");
  } else {
    segments = [];
  }
  const [owner, rawRepo] = segments;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (segments.length === 2 && owner && GITHUB_SEGMENT_PATTERN.test(owner) && repo) {
    const name = validatePluginDirectoryName(repo);
    return { url: `https://github.com/${owner}/${name}.git`, name };
  }
  throw new Error(`Invalid plugin reference: ${ref}. Use user/repo or a GitHub URL.`);
}

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Resolves a bare plugin id through the registry, so `gloomberb install
 * hackernews` works alongside `gloomberb install owner/repo`. Anything already
 * shaped like a repo reference is left alone, and a registry lookup failure
 * falls through to the normal parse error rather than inventing a repo name.
 */
async function resolveRegistryRef(rawRef: string): Promise<string> {
  if (rawRef.includes("/") || rawRef.includes(":") || !PLUGIN_ID_PATTERN.test(rawRef)) return rawRef;

  try {
    const response = await fetch(`https://plugins.gloom.sh/plugins/${rawRef}.json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return rawRef;
    const entry = await response.json() as { repo?: string; bundled?: boolean; name?: string };

    if (entry.bundled) {
      fail(
        `"${entry.name ?? rawRef}" ships with Gloomberb.`,
        `Enable it from the plugin marketplace (PL) instead.`,
      );
    }
    if (typeof entry.repo === "string" && entry.repo.length > 0) {
      console.log(cliStyles.muted(`Resolved "${rawRef}" to ${entry.repo}`));
      return entry.repo;
    }
  } catch {
    // Offline or registry down: fall through so the plain parse error explains
    // the accepted formats rather than blaming the network.
  }
  return rawRef;
}

export async function installPlugin(rawRef: string) {
  ensurePluginsDir();
  const ref = await resolveRegistryRef(rawRef);
  const { url, name } = parseGitHubRef(ref);
  const targetDir = join(PLUGINS_DIR, name);

  if (existsSync(targetDir)) {
    fail(`Plugin "${name}" already exists.`, `Use "gloomberb update ${name}" to refresh it.`);
  }

  console.log(cliStyles.accent(`Installing ${name}`));
  console.log(cliStyles.muted(url));

  try {
    execFileSync("git", ["clone", "--depth", "1", url, targetDir], { stdio: "inherit" });
  } catch {
    rmSync(targetDir, { recursive: true, force: true });
    fail(`Failed to clone ${url}.`);
  }

  const pkgPath = join(targetDir, "package.json");
  if (existsSync(pkgPath)) {
    console.log(cliStyles.muted("Installing plugin dependencies..."));
    try {
      // --production: plugin repos depend on `gloomberb` as a devDependency so
      // their own CI can typecheck against the real API. At runtime the host is
      // symlinked in instead, and pulling a second full copy here would both
      // waste a lot of disk and risk a duplicate React.
      execFileSync("bun", ["install", "--production"], { cwd: targetDir, stdio: "inherit" });
    } catch {
      console.error(cliStyles.warning("Warning: failed to install plugin dependencies."));
    }
  }

  // After `bun install`, which prunes links it does not know about.
  const link = linkHostPackages(targetDir);
  if (link.error) {
    console.error(cliStyles.warning(`Warning: could not link the Gloomberb runtime (${link.error}).`));
    console.error(cliStyles.muted("The plugin's \"gloomberb/*\" imports will not resolve."));
  }

  try {
    let entryFile: string | null = null;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await Bun.file(pkgPath).text());
      if (pkg.main) entryFile = join(targetDir, pkg.main);
    }
    if (!entryFile) {
      for (const candidate of ["index.ts", "index.tsx", "index.js"]) {
        const path = join(targetDir, candidate);
        if (existsSync(path)) {
          entryFile = path;
          break;
        }
      }
    }
    if (entryFile) {
      const mod = await import(entryFile);
      const plugin = mod.default ?? mod.plugin;
      if (plugin?.id && plugin?.name) {
        console.log(cliStyles.success(`Installed ${plugin.name} v${plugin.version || "0.0.0"}`));
        return;
      }
    }
    console.log(cliStyles.warning("Installed files, but no valid GloomPlugin export was found."));
  } catch (err) {
    console.log(cliStyles.warning(`Plugin validation failed: ${err}`));
  }
}

export async function removePlugin(name: string) {
  const targetDir = join(PLUGINS_DIR, validatePluginDirectoryName(name));
  if (!existsSync(targetDir)) {
    fail(`Plugin "${name}" was not found.`, PLUGINS_DIR);
  }
  rmSync(targetDir, { recursive: true, force: true });
  console.log(cliStyles.success(`Removed plugin "${name}".`));
}

export async function updatePlugins(name?: string) {
  ensurePluginsDir();
  const dirs = name
    ? [validatePluginDirectoryName(name)]
    : readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

  if (dirs.length === 0) {
    console.log(cliStyles.muted("No plugins installed."));
    return;
  }

  for (const dir of dirs) {
    const targetDir = join(PLUGINS_DIR, dir);
    if (!existsSync(join(targetDir, ".git"))) {
      console.log(cliStyles.warning(`Skipping ${dir} (not a git repo)`));
      continue;
    }
    console.log(cliStyles.accent(`Updating ${dir}...`));
    try {
      execFileSync("git", ["pull", "--ff-only"], { cwd: targetDir, stdio: "inherit" });
      const pkgPath = join(targetDir, "package.json");
      if (existsSync(pkgPath)) {
        execFileSync("bun", ["install", "--production"], { cwd: targetDir, stdio: "inherit" });
      }
      linkHostPackages(targetDir);
    } catch {
      console.error(cliStyles.danger(`Failed to update ${dir}.`));
    }
  }
}

export function listPlugins() {
  ensurePluginsDir();
  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  if (entries.length === 0) {
    console.log(cliStyles.muted("No plugins installed."));
    console.log(cliStyles.muted("Install one with: gloomberb install <github-user/repo>"));
    return;
  }

  const rows = entries.map((entry) => {
    const dir = join(PLUGINS_DIR, entry.name);
    let version = "—";
    let description = "—";
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        version = pkg.version || "—";
        description = pkg.description || "—";
      } catch {
        description = "Unreadable package.json";
      }
    }
    return [entry.name, version, description];
  });

  console.log(renderSection("Installed Plugins"));
  console.log(renderTable(
    [
      { header: "Plugin" },
      { header: "Version" },
      { header: "Description" },
    ],
    rows,
  ));
  console.log("");
  console.log(renderStat("Directory", PLUGINS_DIR));
}
