import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Decides whether a Pane chrome pull-request run needs the dedicated chat
 * checks (Chromium chat latency/mentions/return probes and WebKit chat
 * painting). Uses a fail-closed exclusion list: any path outside non-chat
 * pane chrome areas runs the chat checks. Pushes to `main` and manual
 * dispatches always run everything.
 *
 *   bun run scripts/pane-chrome/pane-chrome-scope.ts --base <git ref> [--root <checkout>]
 *   bun run scripts/pane-chrome/pane-chrome-scope.ts --files <a,b>
 */

const TEST_ONLY_FILE = /\.test\.tsx?$/;

/**
 * Paths within Pane chrome's trigger set that cannot affect chat rendering,
 * scrollports, mentions, or WebKit transcript painting.
 */
const NON_CHAT_PATTERNS: readonly RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^src\/components\/command-bar\//,
  /^src\/app\/keybindings\//,
  /^src\/shares\//,
  /^src\/plugins\/builtin\/chart-composer\//,
  /^src\/plugins\/builtin\/news\//,
  /^src\/plugins\/builtin\/clinical-trials\//,
  /^src\/plugins\/builtin\/changelog\//,
  /^src\/plugins\/builtin\/ticker-detail\//,
  /^src\/plugins\/builtin\/shared\/series-list-detail\.tsx$/,
  /^src\/components\/chart\//,
  /^src\/time-series\//,
  /^src\/components\/metric-treemap\//,
  /^src\/components\/ui\/(?:query-bar\.tsx|column-grid\.tsx|range-track\.tsx|detail-scroll-body\.tsx|data-table\/)/,
  /^src\/components\/price-performance\.tsx$/,
  /^src\/components\/table-view-shared\.tsx$/,
  /^src\/components\/reader\//,
  /^src\/components\/feed-data-table\//,
  /^src\/components\/data-table\//,
  /^src\/utils\/(?:dom-screenshot.*\.ts|one-shot\.ts|double-escape-close\.ts|screenshot-watermark\.ts)$/,
  /^src\/remote\/pane-screenshot\.ts$/,
  /^scripts\/tui-benchmark-harness\.ts$/,
  /^scripts\/pane-chrome\/(?:axis-|des-|heat-|header-|query-bar-|reader-|layout-checks\.ts$|selection-checks\.ts$|tab-sweep-checks\.ts$|title-tab-checks\.ts$|paint\.ts$|checks\.ts$|screenshot\.ts$|share\.ts$|scope\.ts$|ui-tokens|ui-audit|web-app|frame-budget|drag-smoothness|rest-diff|badge-ink|call-player|chart-axis-zoom|chart-panel-layout|kit-page|layout-sweep|sync-poll|title-tab-webkit|ui-benchmark)/,
  /^\.github\/workflows\/(?!pane-chrome\.yml$)/,
];

export interface PaneChromeScopeResult {
  chatChecks: boolean;
  reason: string;
}

function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function takeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function resolvePaneChromeScope(changedFiles: readonly string[]): PaneChromeScopeResult {
  const files = changedFiles.map(normalizePosix).filter(Boolean);
  if (files.length === 0) {
    return {
      chatChecks: true,
      reason: "No changed files reported; running chat checks.",
    };
  }

  const trigger = files.find((file) => !TEST_ONLY_FILE.test(file) && !NON_CHAT_PATTERNS.some((pattern) => pattern.test(file)));
  if (trigger) {
    return {
      chatChecks: true,
      reason: `Chat checks required (${trigger}).`,
    };
  }

  return {
    chatChecks: false,
    reason: `All ${files.length} changed files are outside chat, DOM renderer, and shell layout paths; skipping chat checks on PR.`,
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
  const root = resolve(takeOption(args, "--root") ?? resolve(import.meta.dir, "../.."));
  const filesArg = takeOption(args, "--files");
  const base = takeOption(args, "--base");
  if (!filesArg && !base) {
    throw new Error("Usage: pane-chrome-scope.ts --base <git ref> [--root <checkout>] | --files <a,b>");
  }
  const changedFiles = filesArg !== undefined
    ? filesArg.split(",").filter(Boolean)
    : readChangedFiles(root, base!);
  const result = resolvePaneChromeScope(changedFiles);
  console.log(result.reason);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `chat_checks=${result.chatChecks}\n`);
  }
}

if (import.meta.main) await main();
