import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CheckResult, CheckRun } from "./results";

/**
 * Turns the Windows desktop check's runs under a folder into index.html (every
 * step with its pictures) and summary.md (a table of checks by build and
 * scale, then what failed), and appends the summary to the job summary.
 *
 *   bun scripts/windows-desktop-check/report.ts <folder> [--known <known-failures.json>]
 *
 * With --known, a failure the file does not list fails the command: the file
 * names the checks a build is known to fail, each with why, as `<check>`,
 * `<check>@<scale>` or `<check>@<machine>`.
 */

const args = process.argv.slice(2);
const root = resolve(args[0] ?? "windows-desktop-check");
const knownIndex = args.indexOf("--known");
const knownPath = knownIndex >= 0 ? args[knownIndex + 1] : undefined;

interface LoadedRun extends CheckRun { dir: string }

async function findRuns(dir: string): Promise<LoadedRun[]> {
  const runs: LoadedRun[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (existsSync(join(path, "results.json"))) {
      runs.push({ ...JSON.parse(await readFile(join(path, "results.json"), "utf8")) as CheckRun, dir: path });
    } else {
      runs.push(...await findRuns(path));
    }
  }
  return runs.sort((a, b) => a.label.localeCompare(b.label) || a.scale - b.scale);
}

const runName = (run: CheckRun) => `${run.label} ${run.version} @ ${run.scale}%`;
const icon = (result: CheckResult | undefined) => !result ? "–" : result.status === "pass" ? "✅" : result.status === "fail" ? "❌" : result.status === "info" ? "ℹ️" : "–";
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const runs = await findRuns(root);
if (!runs.length) {
  console.error(`No results.json under ${root}`);
  process.exit(1);
}

const known: Record<string, string> = knownPath ? (JSON.parse(await readFile(knownPath, "utf8")) as { checks: Record<string, string> }).checks : {};
// A run's label ends with its machine (`head-arm64`): an entry `<check>@arm64` covers that machine only.
const machineOf = (run: CheckRun) => run.label.split("-").at(-1) ?? "";
const isKnown = (run: CheckRun, id: string) => id in known || `${id}@${run.scale}` in known || `${id}@${machineOf(run)}` in known;

const ids: Array<{ id: string; title: string }> = [];
for (const run of runs) {
  for (const result of run.results) if (!ids.some((entry) => entry.id === result.id)) ids.push({ id: result.id, title: result.title });
}

const lines: string[] = [];
lines.push("## Windows desktop check", "");
lines.push(`Screen ${[...new Set(runs.map((run) => run.screen))].join(", ")}. Pictures and every step's numbers are in the job's artifact (index.html).`, "");
lines.push(`| Check | ${runs.map(runName).join(" | ")} |`);
lines.push(`|---|${runs.map(() => ":-:").join("|")}|`);
for (const { id, title } of ids) {
  lines.push(`| ${title} | ${runs.map((run) => {
    const result = run.results.find((entry) => entry.id === id);
    return `${icon(result)}${result?.status === "fail" && knownPath && isKnown(run, id) ? " (known)" : ""}`;
  }).join(" | ")} |`);
}
lines.push("");

const unexpected: string[] = [];
const nowPassing: string[] = [];
for (const run of runs) {
  const failures = run.results.filter((result) => result.status === "fail");
  if (!failures.length) continue;
  lines.push(`### ${runName(run)}: ${failures.length} failed`, "");
  for (const result of failures) {
    const knownNote = knownPath && isKnown(run, result.id) ? " (known)" : "";
    lines.push(`- **${result.title}**${knownNote}: ${result.detail}${result.shots.length ? ` (${result.shots.join(", ")})` : ""}`);
    if (knownPath && !isKnown(run, result.id)) unexpected.push(`${runName(run)}: ${result.title}: ${result.detail}`);
  }
  lines.push("");
}
if (knownPath) {
  for (const id of Object.keys(known)) {
    const [check, where] = id.split("@");
    const relevant = runs.filter((run) => !where || String(run.scale) === where || machineOf(run) === where);
    const results = relevant.map((run) => run.results.find((entry) => entry.id === check)).filter(Boolean) as CheckResult[];
    if (results.length && results.every((result) => result.status === "pass")) nowPassing.push(id);
  }
  if (nowPassing.length) lines.push(`Listed as known failures but passing now (take them off the list): ${nowPassing.join(", ")}`, "");
  if (unexpected.length) lines.push(`**${unexpected.length} failure(s) not on the known list.**`, "");
}

const summary = lines.join("\n");
await writeFile(join(root, "summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

const html: string[] = [
  "<!doctype html><meta charset=utf-8><title>Windows desktop check</title>",
  "<style>body{font:14px system-ui;margin:24px;background:#111;color:#ddd}h2{margin-top:40px}.step{margin:18px 0;padding:12px;border:1px solid #333}.pass{border-left:6px solid #2a2}.fail{border-left:6px solid #d33}.info{border-left:6px solid #57c}img{max-width:640px;margin:6px 6px 0 0;border:1px solid #444;vertical-align:top}figure{display:inline-block;margin:0}figcaption{font-size:11px;color:#999}</style>",
  "<h1>Windows desktop check</h1>",
];
for (const run of runs) {
  html.push(`<h2>${escapeHtml(runName(run))}, screen ${escapeHtml(run.screen)}</h2>`);
  if (run.fatal) html.push(`<pre>${escapeHtml(run.fatal)}</pre>`);
  for (const result of run.results) {
    html.push(`<div class="step ${result.status}"><b>${icon(result)} ${escapeHtml(result.title)}</b> <code>${escapeHtml(result.id)}</code><p>${escapeHtml(result.detail)}</p>`);
    for (const shot of result.shots) {
      const src = relative(root, join(run.dir, "shots", shot)).replaceAll("\\", "/");
      html.push(`<figure><a href="${src}"><img loading=lazy src="${src}"></a><figcaption>${escapeHtml(shot)}</figcaption></figure>`);
    }
    html.push("</div>");
  }
}
await writeFile(join(root, "index.html"), html.join("\n"));

console.log(summary);
if (unexpected.length) {
  console.error(`\n${unexpected.length} failure(s) not on the known list:\n${unexpected.join("\n")}`);
  process.exit(1);
}
