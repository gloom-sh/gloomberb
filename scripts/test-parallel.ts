import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { buildRepoImportGraph, readGitChangedFiles, selectTestsForChanges } from "./test-scope";
import { takeOption } from "./tui-benchmark-harness";

const SKIP_DIRS = new Set([".git", ".hutch", "artifacts", "build", "dist", "node_modules"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|_(?:test|spec)\.[cm]?[jt]sx?$/;

/** Tests that spawn subprocesses, SQLite workers, or renderers take much longer per byte than pure unit tests. */
const HEAVY_TEST_PATH = /(?:^|\/)(?:install|installer|loader|lazy-plugins|entry|shared-file|checkpointer|access|cache|host-modules|host-resolver)\.test\.[jt]sx?$|\.test\.tsx$/;

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

/**
 * Splits tests into work-stealing chunks: heavy subprocess/SQLite/UI files run
 * in single-file chunks at the front so no two slow files serialize on one
 * worker, while fast unit tests batch into medium chunks to amortize Bun startup.
 */
export function buildTestChunks(files: readonly SizedTestFile[], workerCount: number): string[][] {
  if (files.length === 0) return [];
  const sorted = [...files].sort((a, b) => (b.weight - a.weight) || a.path.localeCompare(b.path));
  const chunks: string[][] = [];
  const soloCount = Math.min(sorted.length, Math.max(workerCount * 3, 12));
  let index = 0;
  while (index < soloCount && sorted[index]!.weight >= 500_000) {
    chunks.push([sorted[index]!.path]);
    index += 1;
  }
  const rest = sorted.slice(index);
  if (rest.length > 0) {
    const targetChunkSize = Math.max(8, Math.min(24, Math.ceil(rest.length / Math.max(1, workerCount * 3))));
    for (let offset = 0; offset < rest.length; offset += targetChunkSize) {
      chunks.push(rest.slice(offset, offset + targetChunkSize).map((file) => file.path));
    }
  }
  return chunks;
}

function estimateTestWeight(path: string): number {
  const size = Math.max(1, statSync(path).size);
  return HEAVY_TEST_PATH.test(path.replace(/\\/g, "/")) ? 1_000_000 + size : size;
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
  const ramWorkers = Math.max(4, Math.floor(totalmem() / (2 * 1024 ** 3)));
  const defaultWorkers = Math.max(1, Math.min(8, availableParallelism(), ramWorkers));
  const workerCount = Math.min(
    files.length,
    Number.isFinite(rawWorkers) && rawWorkers > 0 ? rawWorkers : defaultWorkers,
  );
  const rawTimeout = Number.parseInt(process.env.TEST_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 15_000;

  const sizedFiles: SizedTestFile[] = files.map((path) => ({ path, weight: estimateTestWeight(path) }));
  const chunks = buildTestChunks(sizedFiles, workerCount);
  let nextChunk = 0;

  const sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), "gloomberb-test-workers-")));
  const started = performance.now();
  console.log(`Running ${files.length} test files across ${workerCount} isolated workers (${chunks.length} chunks, timeout ${timeoutMs}ms)...`);

  try {
    const outcomes = await Promise.all(
      Array.from({ length: workerCount }, async (_, index) => {
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
        let code = 0;
        let pass = 0;
        let fail = 0;
        let skip = 0;
        let ranFiles = 0;
        const failureOutputs: string[] = [];

        while (true) {
          const chunkIndex = nextChunk++;
          const chunk = chunks[chunkIndex];
          if (!chunk) break;
          ranFiles += chunk.length;
          const proc = Bun.spawn([process.execPath, "test", "--timeout", String(timeoutMs), ...chunk], {
            env: workerEnv,
            stdout: "pipe",
            stderr: "pipe",
          });
          const [chunkCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          const text = `${stdout}${stderr}`;
          const count = (label: string) => {
            const matches = [...text.matchAll(new RegExp(`^\\s*(\\d+) ${label}`, "gm"))];
            return Number(matches.at(-1)?.[1] ?? 0);
          };
          pass += count("pass");
          fail += count("fail");
          skip += count("skip");
          if (chunkCode !== 0) {
            code = chunkCode;
            failureOutputs.push(text.trimEnd());
          }
        }

        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(
          `[worker ${index + 1}/${workerCount}] ${code === 0 ? "PASS" : "FAIL"} ${ranFiles} files (${pass} pass, ${fail} fail, ${skip} skip) in ${sec}s`,
        );
        return { index, code, pass, fail, skip, files: ranFiles, text: failureOutputs.join("\n\n") };
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
