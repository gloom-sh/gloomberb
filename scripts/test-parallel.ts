import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepoImportGraph, readGitChangedFiles, selectTestsForChanges } from "./test-scope";
import { takeOption } from "./tui-benchmark-harness";

const SKIP_DIRS = new Set([".git", ".hutch", "artifacts", "build", "dist", "node_modules"]);
const TEST_FILE = /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$|_(?:test|spec)\.[cm]?[jt]sx?$/;

function collectTests(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === "." ? entry.name : join(dir, entry.name);
    if (entry.isDirectory()) collectTests(rel, out);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) out.push(rel);
  }
}

export interface SizedTestFile {
  path: string;
  weight: number;
}

/**
 * Longest-Processing-Time-first (LPT) scheduling: sort files heaviest first
 * (using file size as a fast proxy for test duration) and assign each to the
 * lightest bucket so worker completion times converge instead of straggling.
 */
export function assignTestBuckets(files: readonly SizedTestFile[], workerCount: number): string[][] {
  const count = Math.max(1, Math.min(workerCount, files.length));
  const sorted = [...files].sort((a, b) => (b.weight - a.weight) || a.path.localeCompare(b.path));
  const buckets: string[][] = Array.from({ length: count }, () => []);
  const loads = new Array<number>(count).fill(0);

  for (const file of sorted) {
    let lightest = 0;
    for (let i = 1; i < count; i++) {
      if (loads[i]! < loads[lightest]!) lightest = i;
    }
    buckets[lightest]!.push(file.path);
    loads[lightest]! += Math.max(1, file.weight);
  }
  return buckets;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const changedFrom = takeOption(args, "--changed-from") ?? process.env.TEST_CHANGED_FROM;

  let files: string[];
  if (changedFrom) {
    const root = resolve(".");
    const changed = readGitChangedFiles(root, changedFrom);
    const graph = buildRepoImportGraph(root);
    const scope = selectTestsForChanges(changed, graph);
    console.log(scope.reason);
    if (scope.mode === "skip") return;
    files = scope.tests;
  } else {
    files = [];
    collectTests(".", files);
    files.sort();
  }

  if (files.length === 0) {
    console.error("No test files found.");
    process.exit(1);
  }

  const rawWorkers = Number.parseInt(process.env.TEST_WORKERS ?? "", 10);
  const defaultWorkers = Math.max(1, Math.min(4, availableParallelism()));
  const workerCount = Math.min(
    files.length,
    Number.isFinite(rawWorkers) && rawWorkers > 0 ? rawWorkers : defaultWorkers,
  );
  const rawTimeout = Number.parseInt(process.env.TEST_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 15_000;

  const sizedFiles: SizedTestFile[] = files.map((path) => ({ path, weight: statSync(path).size }));
  const buckets = assignTestBuckets(sizedFiles, workerCount);

  const sandboxRoot = mkdtempSync(join(tmpdir(), "gloomberb-test-workers-"));
  const started = performance.now();
  console.log(`Running ${files.length} test files across ${workerCount} isolated workers (LPT, timeout ${timeoutMs}ms)...`);

  try {
    const outcomes = await Promise.all(
      buckets.map(async (bucket, index) => {
        const workerRoot = join(sandboxRoot, `w${index + 1}`);
        const workerHome = join(workerRoot, "home");
        const workerTmp = join(workerRoot, "tmp");
        mkdirSync(workerHome, { recursive: true });
        mkdirSync(workerTmp, { recursive: true });

        const workerEnv: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: workerHome,
          TMPDIR: workerTmp,
        };
        // Leave XDG_* and GLOOMBERB_HOME unset so tests that redirect HOME keep full control.
        delete workerEnv.GLOOMBERB_HOME;
        delete workerEnv.XDG_CACHE_HOME;
        delete workerEnv.XDG_CONFIG_HOME;
        delete workerEnv.XDG_DATA_HOME;

        const t0 = performance.now();
        const proc = Bun.spawn([process.execPath, "test", "--timeout", String(timeoutMs), ...bucket], {
          env: workerEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const text = `${stdout}${stderr}`;
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        const count = (label: string) => {
          const matches = [...text.matchAll(new RegExp(`^\\s*(\\d+) ${label}`, "gm"))];
          return Number(matches.at(-1)?.[1] ?? 0);
        };
        const pass = count("pass");
        const fail = count("fail");
        const skip = count("skip");
        console.log(
          `[worker ${index + 1}/${workerCount}] ${code === 0 ? "PASS" : "FAIL"} ${bucket.length} files (${pass} pass, ${fail} fail, ${skip} skip) in ${sec}s`,
        );
        return { index, code, pass, fail, skip, files: bucket.length, text };
      }),
    );

    let failed = false;
    let totalPass = 0;
    let totalFail = 0;
    let totalSkip = 0;
    for (const outcome of outcomes) {
      totalPass += outcome.pass;
      totalFail += outcome.fail;
      totalSkip += outcome.skip;
      if (outcome.code !== 0) {
        failed = true;
        console.error(`\n--- worker ${outcome.index + 1}/${workerCount} output (exit ${outcome.code}) ---`);
        console.error(outcome.text.trimEnd());
      }
    }

    const totalSec = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `Total: ${files.length} files, ${totalPass} pass, ${totalFail} fail, ${totalSkip} skip in ${totalSec}s`,
    );
    process.exitCode = failed ? 1 : 0;
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
