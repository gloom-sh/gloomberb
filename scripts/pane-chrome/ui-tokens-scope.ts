import { appendFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { readCatalog, shardOf } from "./web-app";

/**
 * Resolves which UI tokens views a pull request can affect so CI can skip
 * unchanged areas or audit only the affected built-in functions on a single
 * runner, while failing closed to the full two-shard sweep whenever shared UI,
 * shell, theme, CSS, workflow, dependency, or unknown files change.
 *
 *   bun run scripts/pane-chrome/ui-tokens-scope.ts --base <git ref>
 */

const NON_UI_PATTERNS: readonly RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^src\/cli\//,
  /^src\/data\//,
  /^src\/sync\//,
  /^src\/renderers\/opentui\//,
  /^src\/renderers\/electrobun\/bun\//,
  /\.test\.tsx?$/,
  /^scripts\/(?!build-web\.ts$|pane-chrome\/)/,
  /^\.github\/(?!workflows\/ui-tokens\.yml$|actions\/setup-bun\/)/,
];

/**
 * Importers of built-in plugin modules that do not couple two web/desktop panes
 * together (catalog wiring, CLI-only paths, and native backend paths).
 */
const IGNORED_REVERSE_IMPORTERS: readonly RegExp[] = [
  /^src\/plugins\/catalog/,
  /^src\/plugins\/builtin\/composite\//,
  /^src\/cli\//,
  /^src\/data\//,
  /^src\/sync\//,
  /^src\/renderers\/opentui\//,
  /^src\/renderers\/electrobun\/bun\//,
  /^src\/renderers\/electrobun\/view\/cli-pane-shot-entry\.tsx$/,
];

/** Built-in directories whose modules are shared broadly across panes or the app shell. */
const BASE_FULL_SWEEP_DIRS = new Set(["shared", "composite", "cloud"]);

/** Shell views in ui-audit.ts that mount panes from specific built-in directories. */
const SHELL_VIEWS_BY_BUILTIN_DIR: Readonly<Record<string, readonly string[]>> = {
  "world-indices": [
    "command-bar",
    "command-bar-search",
    "theme-picker",
    "feedback-dialog",
    "pane-settings-dialog",
    "position-form",
    "pane-menu",
  ],
  "portfolio-list": ["foreign-listing"],
  "ticker-detail": ["foreign-listing", "session-cards", "session-cards-menu", "index-history"],
};

const SHELL_VIEW_IDS = new Set([
  "shell",
  "command-bar",
  "command-bar-search",
  "theme-picker",
  "feedback-dialog",
  "pane-settings-dialog",
  "position-form",
  "pane-menu",
  "foreign-listing",
  "session-cards",
  "session-cards-menu",
  "index-history",
]);

/** Above this token count, running the two parallel shards is preferable to one scoped runner. */
const MAX_SCOPED_TOKENS = 24;
const SHARD_COUNT = 2;
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;
const DYNAMIC_PANE_RE = /registerPane(?:Template)?\s*\([\s\S]{0,400}?\b(?:id|paneId)\s*:\s*["']([a-z0-9-]+)["']/g;
const BUILTIN_DIR_RE = /^src\/plugins\/builtin\/([^/]+)\/(.+)$/;

export interface BuiltinScopeIndex {
  /** Every non-test source/JSON file under `src/`, repo-relative POSIX paths. */
  sourceFiles: ReadonlySet<string>;
  /** File-level reverse import graph: target file -> files that statically import it. */
  reverseImports: ReadonlyMap<string, ReadonlySet<string>>;
  /** Built-in directory name -> directly affected catalog tokens and shell views. */
  dirTokens: ReadonlyMap<string, ReadonlySet<string>>;
  /** Built-in directories that always require a full sweep (shared/cloud/status bar widgets). */
  fullSweepDirs: ReadonlySet<string>;
}

export interface UiTokensScopeResult {
  relevant: boolean;
  mode: "skip" | "scoped" | "full";
  only: string[];
  /** 1-based replay snapshot shards needed (`[1]`, `[2]`, `[1, 2]`, or `[]`). */
  replayShards: number[];
  /** 1-based matrix shards to launch (`[1]` for scoped, `[1, 2]` for full, `[]` for skip). */
  matrixShards: number[];
  reason: string;
}

export function isNonUiFile(file: string): boolean {
  return NON_UI_PATTERNS.some((pattern) => pattern.test(file));
}

function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function collectSourceFiles(root: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(root, full, out);
    } else if (/\.(?:tsx?|json)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(normalizePosix(relative(root, full)));
    }
  }
}

function resolveRelativeImport(root: string, fromFile: string, specifier: string, fileSet: ReadonlySet<string>): string | null {
  const base = normalizePosix(relative(root, resolve(root, dirname(fromFile), specifier)));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function addTokensForPaneId(tokens: Set<string>, paneToTokens: ReadonlyMap<string, readonly string[]>, paneId: string | undefined): void {
  if (!paneId) return;
  for (const token of paneToTokens.get(paneId) ?? []) tokens.add(token);
}

export async function buildBuiltinScopeIndex(
  root: string,
  catalog: readonly { token: string; paneId: string }[],
): Promise<BuiltinScopeIndex> {
  const paneToTokens = new Map<string, string[]>();
  for (const entry of catalog) {
    const list = paneToTokens.get(entry.paneId) ?? [];
    list.push(entry.token);
    paneToTokens.set(entry.paneId, list);
  }

  const files: string[] = [];
  collectSourceFiles(root, join(root, "src"), files);
  const sourceFiles = new Set(files);

  const reverseImports = new Map<string, Set<string>>();
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(RELATIVE_IMPORT_RE)) {
      const target = resolveRelativeImport(root, file, match[1]!, sourceFiles);
      if (!target) continue;
      let callers = reverseImports.get(target);
      if (!callers) {
        callers = new Set<string>();
        reverseImports.set(target, callers);
      }
      callers.add(file);
    }
  }

  const builtinRoot = join(root, "src/plugins/builtin");
  const builtinDirs = existsSync(builtinRoot)
    ? readdirSync(builtinRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];

  const fullSweepDirs = new Set(BASE_FULL_SWEEP_DIRS);
  const dirTokens = new Map<string, Set<string>>();

  for (const dir of builtinDirs) {
    const tokens = new Set<string>();
    const dirPrefix = `src/plugins/builtin/${dir}/`;
    const dirFiles = files.filter((file) => file.startsWith(dirPrefix) && /\.tsx?$/.test(file));

    for (const file of dirFiles) {
      const text = readFileSync(join(root, file), "utf8");
      if (/\bstatusBarWidgets\s*:/.test(text)) fullSweepDirs.add(dir);
      if (/\bregisterTickerResearchTab\s*\(/.test(text)) addTokensForPaneId(tokens, paneToTokens, "ticker-research");
      if (/\bregisterCommandBarSearchProvider\s*\(/.test(text)) tokens.add("command-bar-search");
      if (/\bregisterLocalGeoLayer\s*\(/.test(text)) addTokensForPaneId(tokens, paneToTokens, "world-venue-map");
      for (const match of text.matchAll(DYNAMIC_PANE_RE)) {
        addTokensForPaneId(tokens, paneToTokens, match[1]);
      }
    }

    if (!fullSweepDirs.has(dir)) {
      const entryFiles = ["index.ts", "index.tsx", "browser.ts", "browser.tsx", "wire/index.ts", "wire/index.tsx"]
        .map((rel) => join(builtinRoot, dir, rel))
        .filter((candidate) => existsSync(candidate));
      for (const entryFile of entryFiles) {
        try {
          const mod = await import(entryFile);
          for (const value of Object.values(mod)) {
            if (!value || typeof value !== "object") continue;
            const candidate = value as { panes?: Array<{ id?: string }>; paneTemplates?: Array<{ paneId?: string }> };
            for (const pane of candidate.panes ?? []) addTokensForPaneId(tokens, paneToTokens, pane?.id);
            for (const template of candidate.paneTemplates ?? []) addTokensForPaneId(tokens, paneToTokens, template?.paneId);
          }
        } catch {
          // A module that cannot load in isolation stays mapped via static registrations or fails closed when empty.
        }
      }
      for (const shellView of SHELL_VIEWS_BY_BUILTIN_DIR[dir] ?? []) tokens.add(shellView);
    }

    dirTokens.set(dir, tokens);
  }

  return { sourceFiles, reverseImports, dirTokens, fullSweepDirs };
}

function replayShardsFor(tokens: readonly string[]): number[] {
  const shards = new Set<number>();
  for (const token of tokens) {
    if (SHELL_VIEW_IDS.has(token)) shards.add(1);
    else shards.add(shardOf(token, SHARD_COUNT) + 1);
  }
  return [...shards].sort((a, b) => a - b);
}

function fullResult(reason: string): UiTokensScopeResult {
  return {
    relevant: true,
    mode: "full",
    only: [],
    replayShards: [1, 2],
    matrixShards: [1, 2],
    reason,
  };
}

export function resolveUiTokensScope(
  changedFiles: readonly string[],
  index: BuiltinScopeIndex,
): UiTokensScopeResult {
  const files = changedFiles.map(normalizePosix).filter(Boolean);
  if (files.length === 0) {
    return fullResult("No changed files reported; running full UI tokens sweep.");
  }

  const relevantFiles = files.filter((file) => !isNonUiFile(file));
  if (relevantFiles.length === 0) {
    return {
      relevant: false,
      mode: "skip",
      only: [],
      replayShards: [],
      matrixShards: [],
      reason: `All ${files.length} changed files are outside web/desktop UI; skipping UI tokens.`,
    };
  }

  const affectedDirs = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const file of relevantFiles) {
    const match = BUILTIN_DIR_RE.exec(file);
    if (!match) {
      return fullResult(`Changed shared or non-plugin UI file (${file}); running full UI tokens sweep.`);
    }
    const [, dir, rest] = match;
    if (/\.css$/i.test(rest!)) {
      return fullResult(`Changed stylesheet (${file}); running full UI tokens sweep.`);
    }
    if (index.fullSweepDirs.has(dir!)) {
      return fullResult(`Changed shared built-in directory (${dir}); running full UI tokens sweep.`);
    }
    if (!index.dirTokens.has(dir!)) {
      return fullResult(`Changed unknown built-in directory (${dir}); running full UI tokens sweep.`);
    }
    if (!index.sourceFiles.has(file)) {
      return fullResult(`Changed untraced or deleted built-in file (${file}); running full UI tokens sweep.`);
    }
    if (!visited.has(file)) {
      visited.add(file);
      queue.push(file);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const match = BUILTIN_DIR_RE.exec(current);
    if (!match) {
      return fullResult(`Changed file reaches shared UI module (${current}); running full UI tokens sweep.`);
    }
    const dir = match[1]!;
    if (index.fullSweepDirs.has(dir)) {
      return fullResult(`Changed file reaches shared built-in directory (${dir}); running full UI tokens sweep.`);
    }
    if (!index.dirTokens.has(dir)) {
      return fullResult(`Changed file reaches unknown built-in directory (${dir}); running full UI tokens sweep.`);
    }
    affectedDirs.add(dir);

    for (const caller of index.reverseImports.get(current) ?? []) {
      if (IGNORED_REVERSE_IMPORTERS.some((pattern) => pattern.test(caller))) continue;
      if (!visited.has(caller)) {
        visited.add(caller);
        queue.push(caller);
      }
    }
  }

  const tokens = new Set<string>();
  for (const dir of affectedDirs) {
    for (const token of index.dirTokens.get(dir) ?? []) tokens.add(token);
  }
  if (tokens.size === 0) {
    return fullResult(`No catalog tokens resolved for built-in directories (${[...affectedDirs].sort().join(", ")}); running full UI tokens sweep.`);
  }
  if (tokens.size > MAX_SCOPED_TOKENS) {
    return fullResult(`Change affects ${tokens.size} tokens (over ${MAX_SCOPED_TOKENS}); running full 2-shard UI tokens sweep.`);
  }

  const only = [...tokens].sort();
  const replayShards = replayShardsFor(only);
  return {
    relevant: true,
    mode: "scoped",
    only,
    replayShards,
    matrixShards: [1],
    reason: `Scoped UI tokens to ${only.length} target(s) (${only.join(",")}) from ${[...affectedDirs].sort().join(", ")} using replay shard(s) ${replayShards.join(",")}.`,
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
  const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
  const filesArg = takeOption(args, "--files");
  const base = takeOption(args, "--base");
  if (!filesArg && !base) {
    throw new Error("Usage: ui-tokens-scope.ts --base <git ref> [--root <checkout>] | --files <a,b>");
  }
  const changedFiles = filesArg !== undefined
    ? filesArg.split(",").filter(Boolean)
    : readChangedFiles(root, base!);

  let result: UiTokensScopeResult;
  if (changedFiles.length > 0 && changedFiles.every((file) => isNonUiFile(normalizePosix(file)))) {
    result = {
      relevant: false,
      mode: "skip",
      only: [],
      replayShards: [],
      matrixShards: [],
      reason: `All ${changedFiles.length} changed files are outside web/desktop UI; skipping UI tokens.`,
    };
  } else {
    const catalog = readCatalog(root, cacheDir("ui-audit-home"));
    const index = await buildBuiltinScopeIndex(root, catalog);
    result = resolveUiTokensScope(changedFiles, index);
  }

  console.log(result.reason);
  if (process.env.GITHUB_OUTPUT) {
    const matrixJson = JSON.stringify(result.matrixShards.length > 0 ? result.matrixShards : [1]);
    const outputs = [
      `relevant=${result.relevant}`,
      `mode=${result.mode}`,
      `only=${result.only.join(",")}`,
      `replay_shards=${result.replayShards.join(",")}`,
      `matrix_shards=${matrixJson}`,
    ].join("\n");
    await appendFile(process.env.GITHUB_OUTPUT, `${outputs}\n`);
  }
}

if (import.meta.main) await main();
