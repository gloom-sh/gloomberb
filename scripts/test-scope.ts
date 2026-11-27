import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * Static reverse-import graph scoping for `scripts/test-parallel.ts` and
 * `scripts/update-floating-promise-allowlist.ts`.
 *
 * Maps changed files on a pull request to the test files (or runtime files for
 * floating-promise checking) they can affect, while failing closed to the full
 * suite whenever shared configs, harnesses, dependencies, deleted source files,
 * unknown paths, or broad fan-out changes are present.
 */

const SKIP_DIRS = new Set([".git", ".hutch", "artifacts", "build", "dist", "node_modules"]);
const TEST_FILE_RE = /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$|_(?:test|spec)\.[cm]?[jt]sx?$/;
const CODE_FILE_RE = /\.[cm]?[jt]sx?$/;
const INDEXED_FILE_RE = /\.(?:[cm]?[jt]sx?|json|css|sql|sh|ps1)$/;
const IMPORT_SPEC_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;

/** Files whose changes invalidate scoped test selection and force the full suite. */
const FULL_TEST_TRIGGERS: readonly RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^knip\.jsonc$/,
  /^electrobun\.config\.ts$/,
  /^patches\//,
  /^\.github\/workflows\/verify\.yml$/,
  /^\.github\/actions\/setup-bun\//,
  /^scripts\/(?:test-parallel\.ts|test-scope\.ts|test-app-env\.ts)$/,
  /^src\/test-support\//,
  /^src\/renderers\/opentui\/test-utils\.tsx$/,
  /^src\/renderers\/dom\/test-utils\.tsx$/,
];

/** Files whose changes force a full floating-promise scan across all `src/` runtime files. */
const FULL_FLOATING_PROMISE_TRIGGERS: readonly RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^src\/architecture\/floating-promise-allowlist\.json$/,
  /^scripts\/update-floating-promise-allowlist\.ts$/,
  /^scripts\/update-silent-catch-allowlist\.ts$/,
  /^\.github\/workflows\/verify\.yml$/,
  /^\.github\/actions\/setup-bun\//,
];

/** Pure documentation and static asset files that do not affect unit tests. */
const NON_TEST_PATTERNS: readonly RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^assets\//,
  /^plugin-icons\//,
  /^plugin-manifest\.json$/,
  /^\.(?:gitignore|gitattributes|editorconfig|npmrc)$/,
];

/**
 * Built-in plugin registration barrels aggregate individual plugins into
 * catalog lists without calling into plugin internals. When an individual
 * plugin file changes, we still run the barrel's direct catalog integrity tests
 * (plus `src/plugins/catalog-*.test.ts` and `catalog-snapshot.test.ts`), but we
 * do not propagate reverse imports through these barrels into every unrelated
 * CLI/app test. Editing a barrel directly bypasses this barrier and walks all
 * callers normally.
 */
const PLUGIN_REGISTRATION_BARREL_RE = /^(?:src\/plugins\/catalog(?:-[a-z-]+)?\.ts|src\/plugins\/builtin\/composite\/[^/]+\.ts)$/;

/** Above this threshold, running the full parallel test suite is safer and comparable in time. */
const MAX_SCOPED_TESTS = 250;
/** Above this threshold, a full floating-promise program scan is preferable to scoped scanning. */
const MAX_SCOPED_FLOATING_FILES = 120;

export interface RepoImportGraph {
  /** Every indexed file in the checkout (repo-relative POSIX paths). */
  allFiles: ReadonlySet<string>;
  /** Every discovered test file in the checkout (sorted POSIX paths). */
  testFiles: readonly string[];
  /** Target file -> files (source or test) that statically import/require it. */
  reverseImports: ReadonlyMap<string, ReadonlySet<string>>;
  /** Map from `gloomberb` / `gloomberb/<subpath>` package exports to repo-relative target paths. */
  packageExports: ReadonlyMap<string, string>;
}

export interface TestScopeResult {
  mode: "skip" | "scoped" | "full";
  tests: string[];
  reason: string;
}

export interface FloatingPromiseScopeResult {
  mode: "skip" | "scoped" | "full";
  /** Repo-relative POSIX paths under `src/` to scan when `mode === "scoped"`. */
  files: string[];
  reason: string;
}

function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

function isPluginRegistrationBarrel(path: string): boolean {
  return PLUGIN_REGISTRATION_BARREL_RE.test(path);
}

function readPackageExports(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return map;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; exports?: Record<string, unknown> };
    const name = pkg.name;
    if (!name || !pkg.exports || typeof pkg.exports !== "object") return map;
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target !== "string") continue;
      const spec = subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`;
      map.set(spec, target.replace(/^\.\//, ""));
    }
  } catch {
    // Ignore malformed package.json; relative imports still resolve.
  }
  return map;
}

function walkRepo(root: string, dir: string, allFiles: string[], testFiles: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRepo(root, full, allFiles, testFiles);
    } else if (entry.isFile()) {
      const rel = normalizePosix(relative(root, full));
      if (isTestFile(rel)) {
        allFiles.push(rel);
        testFiles.push(rel);
      } else if (INDEXED_FILE_RE.test(entry.name)) {
        allFiles.push(rel);
      }
    }
  }
}

function resolveImportTarget(
  root: string,
  fromFile: string,
  specifier: string,
  allFiles: ReadonlySet<string>,
  packageExports: ReadonlyMap<string, string>,
): string | null {
  if (specifier.startsWith(".")) {
    const base = normalizePosix(relative(root, resolve(root, dirname(fromFile), specifier)));
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.mts`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}.json`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.jsx`,
    ]) {
      if (allFiles.has(candidate)) return candidate;
    }
    return null;
  }
  const exported = packageExports.get(specifier);
  if (exported && allFiles.has(exported)) return exported;
  return null;
}

export function buildRepoImportGraph(root: string): RepoImportGraph {
  const allList: string[] = [];
  const testList: string[] = [];
  walkRepo(root, root, allList, testList);
  testList.sort();
  const allFiles = new Set(allList);
  const packageExports = readPackageExports(root);
  const reverseImports = new Map<string, Set<string>>();

  for (const file of allList) {
    if (!CODE_FILE_RE.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(IMPORT_SPEC_RE)) {
      const target = resolveImportTarget(root, file, match[1]!, allFiles, packageExports);
      if (!target || target === file) continue;
      let callers = reverseImports.get(target);
      if (!callers) {
        callers = new Set<string>();
        reverseImports.set(target, callers);
      }
      callers.add(file);
    }
  }

  return { allFiles, testFiles: testList, reverseImports, packageExports };
}

function fileStem(path: string): string {
  return basename(path).replace(/\.[cm]?[jt]sx?$/, "");
}

function addSiblingTests(file: string, testFilesByDir: ReadonlyMap<string, readonly string[]>, out: Set<string>): void {
  const dir = dirname(file);
  const candidates = testFilesByDir.get(dir);
  if (!candidates) return;
  const stem = fileStem(file);
  for (const testFile of candidates) {
    const base = basename(testFile);
    if (
      base.startsWith(`${stem}.test.`)
      || base.startsWith(`${stem}.spec.`)
      || base.startsWith(`${stem}.desktop.test.`)
      || base.startsWith(`${stem}_test.`)
      || base === "index.test.ts"
      || base === "index.test.tsx"
    ) {
      out.add(testFile);
    }
  }
}

function indexTestsByDir(testFiles: readonly string[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const testFile of testFiles) {
    const dir = dirname(testFile);
    let list = byDir.get(dir);
    if (!list) {
      list = [];
      byDir.set(dir, list);
    }
    list.push(testFile);
  }
  return byDir;
}

export function selectTestsForChanges(
  changedFiles: readonly string[],
  graph: RepoImportGraph,
): TestScopeResult {
  const files = changedFiles.map(normalizePosix).filter(Boolean);
  const full = (reason: string): TestScopeResult => ({
    mode: "full",
    tests: [...graph.testFiles],
    reason,
  });

  if (files.length === 0) {
    return full("No changed files reported; running full test suite.");
  }

  for (const file of files) {
    if (FULL_TEST_TRIGGERS.some((pattern) => pattern.test(file))) {
      return full(`Global config, harness, or workflow file changed (${file}); running full test suite.`);
    }
  }

  const testsByDir = indexTestsByDir(graph.testFiles);
  const architectureTests = graph.testFiles.filter((file) => file.startsWith("src/architecture/"));
  const catalogTests = graph.testFiles.filter(
    (file) => file === "src/cli/pane-functions/catalog-snapshot.test.ts" || /^src\/plugins\/catalog-[^/]+\.test\.tsx?$/.test(file),
  );

  const selected = new Set<string>();
  const changedSet = new Set(files);
  const bfsQueue: string[] = [];
  const bfsVisited = new Set<string>();
  let touchedSrcRuntime = false;
  let touchedPluginCatalogSurface = false;
  let touchedPublicSurface = false;

  for (const file of files) {
    if (NON_TEST_PATTERNS.some((pattern) => pattern.test(file))) continue;

    if (isTestFile(file)) {
      if (graph.allFiles.has(file)) selected.add(file);
      continue;
    }

    if (file.startsWith(".github/workflows/") || file.startsWith(".github/actions/")) {
      if (graph.allFiles.has("scripts/release-workflows.test.ts")) selected.add("scripts/release-workflows.test.ts");
      if ((file === ".github/workflows/nightly.yml" || file === ".github/workflows/verify-windows.yml") && graph.allFiles.has("scripts/nightly.test.ts")) {
        selected.add("scripts/nightly.test.ts");
      }
      continue;
    }

    if (file.startsWith("bin/")) {
      if (graph.allFiles.has("scripts/npm-without-bun.test.ts")) selected.add("scripts/npm-without-bun.test.ts");
      if (graph.allFiles.has("scripts/install.test.ts")) selected.add("scripts/install.test.ts");
      continue;
    }

    if (file === "scripts/install.sh" || file === "scripts/install.ps1") {
      if (graph.allFiles.has("scripts/install.test.ts")) selected.add("scripts/install.test.ts");
      continue;
    }

    if (!file.startsWith("src/") && !file.startsWith("scripts/")) {
      return full(`Changed file outside traced source/script trees (${file}); running full test suite.`);
    }

    if (!graph.allFiles.has(file)) {
      return full(`Deleted or untraced source file (${file}); running full test suite.`);
    }

    if (file.startsWith("src/")) {
      touchedSrcRuntime = true;
      if (file.startsWith("src/plugins/builtin/") || file.startsWith("src/plugins/catalog") || file.startsWith("src/cli/pane-functions/")) {
        touchedPluginCatalogSurface = true;
      }
      if (file.startsWith("src/public/") || file.startsWith("src/types/")) {
        touchedPublicSurface = true;
      }
    }

    addSiblingTests(file, testsByDir, selected);
    if (!bfsVisited.has(file)) {
      bfsVisited.add(file);
      bfsQueue.push(file);
    }
  }

  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift()!;
    for (const caller of graph.reverseImports.get(current) ?? []) {
      if (isTestFile(caller)) {
        selected.add(caller);
        continue;
      }
      if (isPluginRegistrationBarrel(caller) && !changedSet.has(caller)) {
        for (const barrelCaller of graph.reverseImports.get(caller) ?? []) {
          if (isTestFile(barrelCaller)) selected.add(barrelCaller);
        }
        continue;
      }
      if (!bfsVisited.has(caller)) {
        bfsVisited.add(caller);
        bfsQueue.push(caller);
      }
    }
  }

  if (touchedSrcRuntime) {
    for (const testFile of architectureTests) selected.add(testFile);
  }
  if (touchedPluginCatalogSurface) {
    for (const testFile of catalogTests) selected.add(testFile);
  }
  if (touchedPublicSurface && graph.allFiles.has("src/public/public-api.test.ts")) {
    selected.add("src/public/public-api.test.ts");
  }

  if (selected.size === 0) {
    return {
      mode: "skip",
      tests: [],
      reason: `No test files affected by ${files.length} changed file(s); skipping test run.`,
    };
  }

  if (selected.size > MAX_SCOPED_TESTS) {
    return full(`Change reaches ${selected.size} test files (over ${MAX_SCOPED_TESTS}); running full test suite.`);
  }

  const tests = [...selected].sort();
  return {
    mode: "scoped",
    tests,
    reason: `Scoped to ${tests.length} of ${graph.testFiles.length} test files from ${files.length} changed file(s).`,
  };
}

export function selectFloatingPromiseFiles(
  changedFiles: readonly string[],
  graph: RepoImportGraph,
  runtimeSrcFiles: readonly string[],
): FloatingPromiseScopeResult {
  const files = changedFiles.map(normalizePosix).filter(Boolean);
  const runtimeSet = new Set(runtimeSrcFiles.map(normalizePosix));
  const full = (reason: string): FloatingPromiseScopeResult => ({
    mode: "full",
    files: [...runtimeSet].sort(),
    reason,
  });

  if (files.length === 0) {
    return full("No changed files reported; running full floating-promise scan.");
  }

  for (const file of files) {
    if (FULL_FLOATING_PROMISE_TRIGGERS.some((pattern) => pattern.test(file))) {
      return full(`Floating-promise config, allowlist, or scanner changed (${file}); running full scan.`);
    }
  }

  const changedSet = new Set(files);
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const file of files) {
    if (!file.startsWith("src/")) continue;
    if (isTestFile(file) || /\.d\.ts$/.test(file) || file.startsWith("src/test-support/")) continue;
    if (!CODE_FILE_RE.test(file)) continue;
    if (!graph.allFiles.has(file)) {
      return full(`Deleted runtime source file (${file}); running full floating-promise scan.`);
    }
    if (!visited.has(file)) {
      visited.add(file);
      queue.push(file);
    }
  }

  const affected = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (runtimeSet.has(current)) affected.add(current);
    for (const caller of graph.reverseImports.get(current) ?? []) {
      if (isTestFile(caller)) continue;
      if (isPluginRegistrationBarrel(caller) && !changedSet.has(caller)) continue;
      if (!visited.has(caller)) {
        visited.add(caller);
        queue.push(caller);
      }
    }
    if (affected.size > MAX_SCOPED_FLOATING_FILES) {
      return full(`Change reaches more than ${MAX_SCOPED_FLOATING_FILES} runtime files; running full floating-promise scan.`);
    }
  }

  if (affected.size === 0) {
    return {
      mode: "skip",
      files: [],
      reason: `No runtime src/ files affected by ${files.length} changed file(s); skipping floating-promise AST scan.`,
    };
  }

  const scoped = [...affected].sort();
  return {
    mode: "scoped",
    files: scoped,
    reason: `Scoped floating-promise scan to ${scoped.length} of ${runtimeSet.size} runtime file(s).`,
  };
}

export function readGitChangedFiles(root: string, base: string): string[] {
  const diff = Bun.spawnSync(["git", "diff", "--name-only", base, "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed: ${diff.stderr.toString().trim()}`);
  }
  return diff.stdout.toString().split("\n").filter(Boolean);
}
