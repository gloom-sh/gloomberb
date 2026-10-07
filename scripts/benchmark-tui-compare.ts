import { appendFile } from "fs/promises";
import { join, resolve } from "path";
import { median, positiveInteger, takeOption } from "./tui-benchmark-harness";

/**
 * Runs the navigation benchmark against a base checkout and this one, taking
 * turns so a machine that slows down mid-job slows both sides, and fails when
 * the typical keypress (p50) is clearly slower here.
 *
 * p50 is the gate because it is the stable number: across five alternating
 * runs before and after #904 every p50 on one side beat every p50 on the other,
 * while p95 on identical code ranged 6 to 15 ms. p95 and max are reported only.
 */

interface NavigationReport {
  medianCellsUpdated: number;
  peakRssMiB: number;
  summary: { p50Ms: number; p95Ms: number; maxMs: number };
}

const args = process.argv.slice(2);
const baseRoot = takeOption(args, "--base");
if (!baseRoot) throw new Error("Usage: benchmark-tui-compare.ts --base <checkout> [--runs 5]");
const runs = positiveInteger(takeOption(args, "--runs"), 5, "runs");
// Starting limits, to be tuned from CI's own spread. Locally the p50 spread
// was about 0.2 ms, so a regression has to clear both to fail.
const maxRatio = 1.2;
const minDeltaMs = 0.5;
const sides = { base: resolve(baseRoot), head: resolve(join(import.meta.dir, "..")) };
const benchmark = join(import.meta.dir, "benchmark-tui-navigation.ts");

const reports: Record<keyof typeof sides, NavigationReport[]> = { base: [], head: [] };
for (let run = 1; run <= runs; run += 1) {
  for (const side of ["base", "head"] as const) {
    reports[side].push(await runBenchmark(sides[side], `${side} ${run}/${runs}`));
  }
}

const rows = [
  ["typical keypress (p50)", "ms", (report: NavigationReport) => report.summary.p50Ms],
  ["slow keypress (p95)", "ms", (report: NavigationReport) => report.summary.p95Ms],
  ["slowest keypress", "ms", (report: NavigationReport) => report.summary.maxMs],
  ["peak memory", "MiB", (report: NavigationReport) => report.peakRssMiB],
  ["cells redrawn per keypress", "", (report: NavigationReport) => report.medianCellsUpdated],
] as const;
const medians = rows.map(([, , pick]) => ({
  base: median(reports.base.map(pick)),
  head: median(reports.head.map(pick)),
}));

const [p50] = medians;
const slower = p50!.head > p50!.base * maxRatio && p50!.head - p50!.base >= minDeltaMs;
const cells = medians[4]!;
const lines = [
  "### TUI navigation benchmark",
  "",
  `Middle value of ${runs} alternating runs per side.`,
  "",
  "| | main | this PR |",
  "|---|---|---|",
  ...rows.map(([label, unit], index) => `| ${label} | ${format(medians[index]!.base, unit)} | ${format(medians[index]!.head, unit)} |`),
  "",
  slower
    ? `**Slower:** the typical keypress went from ${p50!.base} to ${p50!.head} ms (limit: +${Math.round((maxRatio - 1) * 100)}% and +${minDeltaMs} ms).`
    : "The typical keypress is within the limit.",
  ...(cells.base !== cells.head
    ? ["", `Cells redrawn per keypress changed from ${cells.base} to ${cells.head}. Check that the extra redraw is intended.`]
    : []),
];
const markdown = `${lines.join("\n")}\n`;
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
if (slower) process.exitCode = 1;

async function runBenchmark(root: string, label: string): Promise<NavigationReport> {
  // Two retries: a failed launch is a broken run, not a slowdown.
  for (let attempt = 1; ; attempt += 1) {
    const child = Bun.spawn(["bun", "run", benchmark, "--root", root, "--count", "30", "--interval", "25"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode === 0) {
      const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as NavigationReport;
      console.error(`${label}: p50 ${report.summary.p50Ms} ms, p95 ${report.summary.p95Ms} ms`);
      return report;
    }
    if (attempt === 3) throw new Error(`The benchmark could not run (${label}):\n${stderr.trim()}`);
    console.error(`${label}: benchmark failed to run, retrying`);
  }
}

function format(value: number, unit: string): string {
  return unit ? `${Math.round(value * 100) / 100} ${unit}` : String(value);
}
