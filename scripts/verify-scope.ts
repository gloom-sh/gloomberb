import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { takeOption } from "./tui-benchmark-harness";

/**
 * Decides whether a pull request needs the heavy standalone binary build
 * (QEMU + Linux x64/musl binaries + 0.5.0 global upgrade smoke) and the
 * external registry plugin compile/load suite in `.github/workflows/verify.yml`.
 * Pushes to `main` and manual dispatches always run everything.
 *
 *   bun run scripts/verify-scope.ts --base <git ref>
 */

const TEST_ONLY_FILE = /\.test\.tsx?$/;

/**
 * Paths that can affect standalone compiled binaries (`scripts/build.ts`) or
 * the 0.5.0 global package upgrade smoke test (`scripts/smoke-global-upgrade.ts`).
 */
const CORE_BINARY_PATTERNS: readonly RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^patches\//,
  /^bin\//,
  /^src\/cli\//,
  /^src\/renderers\/opentui\//,
  /^src\/renderers\/electrobun\/view\/cli-pane-shot-entry\.tsx$/,
  /^src\/plugins\/(?!builtin\/)/,
  /^src\/public\//,
  /^src\/utils\/linux-libc\.ts$/,
  /^src\/version\.ts$/,
  /^scripts\/(?:build\.ts|catalog-snapshot-file\.ts|smoke-global-upgrade\.ts|windows-signing\.ts|test-app-env\.ts|verify-scope\.ts)$/,
  /^\.github\/(?:workflows\/verify\.yml$|actions\/setup-bun\/)/,
];

/**
 * Fail-closed exclusion list for `registry-plugins`: paths guaranteed not to
 * affect `package.json` plugin API exports, host module resolution, or
 * packaged terminal plugin loading. Any path outside this list runs the job.
 */
const NON_REGISTRY_PLUGIN_PATTERNS: readonly RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^assets\//,
  /^plugin-icons\//,
  /^plugin-manifest\.json$/,
  /^src\/architecture\/[^/]+\.json$/,
  /^src\/plugins\/builtin\//,
  /^src\/renderers\/(?:dom|browser|share)\//,
  /^src\/renderers\/electrobun\/view\//,
  /^src\/(?:api-client|sync|telemetry|updater|feedback|team|account|ask-gloom|shares|notifications|layout-marketplace|docs|news|assets)\//,
  /^src\/components\/(?:command-bar|onboarding)\//,
  /^src\/components\/layout\/(?:shell\/|header|status-bar)/,
  /^scripts\/(?!build\.ts$|catalog-snapshot-file\.ts$|check-registry-plugins\.ts$|check-packaged-registry-plugins\.ts$|desktop-tui-bundle\.ts$|packaged-plugin-load\.ts$|registry-plugins\.ts$|test-app-env\.ts$|verify-scope\.ts$)/,
  /^\.github\/(?!workflows\/verify\.yml$|actions\/setup-bun\/)/,
];

export interface VerifyScopeResult {
  coreBinaries: boolean;
  registryPlugins: boolean;
  coreBinariesReason: string;
  registryPluginsReason: string;
}

function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function resolveVerifyScope(changedFiles: readonly string[]): VerifyScopeResult {
  const files = changedFiles.map(normalizePosix).filter(Boolean);
  if (files.length === 0) {
    return {
      coreBinaries: true,
      registryPlugins: true,
      coreBinariesReason: "No changed files reported; building core binaries.",
      registryPluginsReason: "No changed files reported; checking registry plugins.",
    };
  }

  const coreTrigger = files.find((file) => !TEST_ONLY_FILE.test(file) && CORE_BINARY_PATTERNS.some((pattern) => pattern.test(file)));
  const registryTrigger = files.find((file) => !TEST_ONLY_FILE.test(file) && !NON_REGISTRY_PLUGIN_PATTERNS.some((pattern) => pattern.test(file)));

  return {
    coreBinaries: coreTrigger !== undefined,
    registryPlugins: registryTrigger !== undefined,
    coreBinariesReason: coreTrigger
      ? `Core binary build required (${coreTrigger}).`
      : `All ${files.length} changed files are outside CLI/packaging/plugin-host paths; skipping core binary build on PR.`,
    registryPluginsReason: registryTrigger
      ? `Registry plugin compatibility check required (${registryTrigger}).`
      : `All ${files.length} changed files are outside public plugin host exports and packaging; skipping registry plugins on PR.`,
  };
}

function readChangedFiles(root: string, base: string): string[] {
  const diff = Bun.spawnSync(["git", "diff", "--name-only", base, "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed: ${diff.stderr.toString().trim()}`);
  }
  return diff.stdout.toString().split("\n").filter(Boolean);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = resolve(takeOption(args, "--root") ?? resolve(import.meta.dir, ".."));
  const filesArg = takeOption(args, "--files");
  const base = takeOption(args, "--base");
  if (!filesArg && !base) {
    throw new Error("Usage: verify-scope.ts --base <git ref> [--root <checkout>] | --files <a,b>");
  }
  const changedFiles = filesArg !== undefined
    ? filesArg.split(",").filter(Boolean)
    : readChangedFiles(root, base!);
  const result = resolveVerifyScope(changedFiles);
  console.log(result.coreBinariesReason);
  console.log(result.registryPluginsReason);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `core_binaries=${result.coreBinaries}\nregistry_plugins=${result.registryPlugins}\n`,
    );
  }
}

if (import.meta.main) await main();
