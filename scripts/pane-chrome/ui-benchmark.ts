import { appendFile, cp, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { pixelChange } from "./ui-audit-compare";

/**
 * The UI blast radius of a change (docs/pane-conventions.md, "Holding the
 * line"): every function's views, the bundled and registry plugins' panes and
 * the shell, pictured on the base and on the head at 640 and 1280 px in
 * Chromium, pane bodies compared pixel by pixel, and the views that moved laid
 * out before, after and their difference, with "N of M views changed". It
 * reports; it never fails a change for moving pixels.
 *
 *   bun run ui:benchmark [--base <ref>] [--out <dir>] [--replay <dir>] [--widths 640,1280] [--only T,MAP]
 *   bun run ui:benchmark shoot --base <ref> --shard 0/8 --out <dir>     one shard (CI)
 *   bun run ui:benchmark report --shards <dir> --out <dir> [--comment <pr>]
 *
 * Both sides read Gloom Cloud from one replay folder (web-app.ts), offline,
 * so both draw the same data and neither is pictured while a fetch is still
 * out: first the base is opened once without pictures, fetching what the
 * replay lacks and keeping it, then both sides are pictured from what was
 * kept. `--offline` skips the fetching pass (a kept snapshot, as CI restores
 * it), so a read the snapshot lacks draws the same offline state on both. The base is a worktree of `--base`
 * (default: where HEAD left origin/main) under the cache folder; the head is
 * this checkout. The audit of each side is ui-audit.ts, from this checkout.
 */

const MARKER = "<!-- ui-benchmark -->";
/** A view changed when this share of its body's pixels differs in some width (ui-audit-compare.ts). */
const MOVED = 0.0005;
const BODY_INSET = { top: 42, bottom: 42 };
const SHEET_ROWS = 6;

function sh(command: string[], options: { cwd?: string; quiet?: boolean } = {}): string {
  const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: options.quiet ? "pipe" : "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed (exit ${result.exitCode})`);
  return options.quiet ? (result.stdout?.toString() ?? "").trim() : "";
}

function git(args: string[], cwd = process.cwd()): string {
  return sh(["git", ...args], { cwd, quiet: true });
}

/** A detached worktree of `sha`, its dependencies installed, reused while it exists. */
function baseWorktree(sha: string): string {
  const dir = cacheDir("ui-benchmark", `base-${sha.slice(0, 12)}`);
  // --force takes over a worktree whose folder was deleted but is still registered.
  if (!existsSync(join(dir, "package.json"))) sh(["git", "worktree", "add", "--detach", "--force", dir, sha]);
  if (!existsSync(join(dir, "node_modules"))) sh(["bun", "install", "--frozen-lockfile"], { cwd: dir });
  return dir;
}

interface ShootOptions { base: string; out: string; replay: string; widths: string; shard?: string; only?: string; offline: boolean }

/**
 * One pass of the audit, white theme only, no report: `fetch` opens every view
 * once to fill the replay (no pictures, the widest width); `before` and
 * `after` picture each side from the replay, offline; the `-again` passes
 * picture the moved views on each side a second time, to tell a change from a
 * view that is never drawn the same twice.
 */
function audit(pass: "fetch" | "before" | "after" | "before-again" | "after-again", root: string, options: ShootOptions): void {
  const side = pass === "after" || pass === "after-again" ? "after" : "before";
  const build = pass === "fetch" || pass === "after" || (pass === "before" && options.offline);
  sh([
    "bun", join(import.meta.dir, "ui-audit.ts"), "--registry", "--no-report", "--themes", "white", "--root", root,
    "--widths", pass === "fetch" ? options.widths.split(",").at(-1)! : options.widths,
    "--out", join(options.out, pass), "--web", join(options.out, `web-${side}`), "--replay", options.replay,
    ...(build ? ["--build"] : []),
    ...(pass === "fetch" ? ["--no-shots"] : ["--offline"]),
    ...(options.shard ? ["--shard", options.shard] : []),
    ...(options.only ? ["--only", options.only] : []),
  ]);
}

async function shoot(options: ShootOptions): Promise<void> {
  const sha = git(["rev-parse", options.base]);
  await mkdir(options.out, { recursive: true });
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
  await Bun.write(join(options.out, "sides.json"), JSON.stringify({ base: sha, head: git(["rev-parse", "HEAD"]), dirty, shard: options.shard ?? "0/1", offline: options.offline }));
  const base = baseWorktree(sha);
  if (!options.offline) {
    audit("fetch", base, options);
    await rm(join(options.out, "fetch"), { recursive: true, force: true });
  }
  audit("before", base, options);
  const head = resolve(join(import.meta.dir, "../.."));
  audit("after", head, options);
  // A view that moved is pictured once more on each side: if two pictures of the same code
  // differ, the view is unsteady (a 3D surface's labels, a value read from the clock), not changed.
  const moving = (await changes(join(options.out, "before"), join(options.out, "after"))).filter(moved);
  const unsteady = new Set<string>();
  if (moving.length) {
    const only = [...new Set(moving.map((change) => change.view.split("--")[0]!))].join(",");
    for (const [side, root] of [["before", base], ["after", head]] as const) {
      audit(`${side}-again`, root, { ...options, only });
      const twice = new Map((await changes(join(options.out, side), join(options.out, `${side}-again`))).map((change) => [change.view, change]));
      for (const change of moving) {
        const second = twice.get(change.view);
        // Drawn differently, or opened only once of the two times (a detail Enter opened while the root was still moving).
        if (second && moved(second)) unsteady.add(change.view);
      }
    }
  }
  await Bun.write(join(options.out, "unsteady.json"), JSON.stringify([...unsteady]));
  // The builds are large and each side's results and pictures are what the report reads.
  await rm(join(options.out, "web-before"), { recursive: true, force: true });
  await rm(join(options.out, "web-after"), { recursive: true, force: true });
  await rm(join(options.out, "before-again"), { recursive: true, force: true });
  await rm(join(options.out, "after-again"), { recursive: true, force: true });
}

async function lines(file: string): Promise<string[]> {
  return existsSync(file) ? (await Bun.file(file).text()).split("\n").filter(Boolean) : [];
}

/** Shard runs (one folder each, with before/ and after/) folded into one before/ and one after/. */
async function merge(shardsDir: string, out: string): Promise<{ base: string; head: string; dirty?: boolean; offline: boolean; shards: number; unsteady: string[] }> {
  const shards = (await readdir(shardsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(shardsDir, entry.name));
  let sides: { base: string; head: string; dirty?: boolean; offline: boolean } = { base: "", head: "", offline: false };
  for (const side of ["before", "after"] as const) {
    const target = join(out, side);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const results: string[] = [];
    const views: string[] = [];
    for (const shard of shards) {
      if (existsSync(join(shard, "sides.json"))) sides = await Bun.file(join(shard, "sides.json")).json();
      results.push(...await lines(join(shard, side, "results.jsonl")));
      views.push(...await lines(join(shard, side, "views.jsonl")));
      if (existsSync(join(shard, side, "shots"))) await cp(join(shard, side, "shots"), join(target, "shots"), { recursive: true });
    }
    await Bun.write(join(target, "results.jsonl"), results.length ? `${results.join("\n")}\n` : "");
    await Bun.write(join(target, "views.jsonl"), views.length ? `${views.join("\n")}\n` : "");
  }
  const unsteady: string[] = [];
  for (const shard of shards) if (existsSync(join(shard, "unsteady.json"))) unsteady.push(...await Bun.file(join(shard, "unsteady.json")).json() as string[]);
  return { ...sides, shards: shards.length, unsteady };
}

interface ViewChange { view: string; widths: Record<string, number | "resized" | "missing" | "error"> }

/** Every view pictured in either run, its body's change per width: a share of pixels, or why it could not be compared. */
async function changes(beforeDir: string, afterDir: string): Promise<ViewChange[]> {
  const byView = new Map<string, ViewChange>();
  for (const dir of [beforeDir, afterDir]) {
    const shots = join(dir, "shots", "white");
    for (const width of existsSync(shots) ? await readdir(shots) : []) {
      for (const file of await readdir(join(shots, width))) {
        const view = file.replace(/\.jpg$/, "");
        const entry = byView.get(view) ?? { view, widths: {} };
        byView.set(view, entry);
        if (entry.widths[width] !== undefined) continue;
        const before = join(beforeDir, "shots", "white", width, file);
        const after = join(afterDir, "shots", "white", width, file);
        if (!existsSync(before) || !existsSync(after)) { entry.widths[width] = "missing"; continue; }
        const result = pixelChange(before, after, undefined, BODY_INSET);
        entry.widths[width] = result.status === "compared" ? result.change : result.status;
      }
    }
  }
  return [...byView.values()].sort((a, b) => a.view.localeCompare(b.view));
}

const moved = (change: ViewChange) => Object.values(change.widths).some((value) => value === "resized" || value === "missing" || (typeof value === "number" && value > MOVED));
const worst = (change: ViewChange) => Math.max(0, ...Object.values(change.widths).map((value) => typeof value === "number" ? value : 1));
const percent = (value: number | string) => typeof value === "number" ? `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%` : value;

function sheetFont(): string[] {
  const fonts = Bun.spawnSync(["convert", "-list", "font"]).stdout.toString();
  const font = ["JetBrains-Mono-Regular", "DejaVu-Sans-Mono", "Liberation-Mono"].find((name) => fonts.includes(`Font: ${name}\n`));
  return font ? ["-font", font] : [];
}

/** The views that moved, worst first: before, after and where they differ, at the width they moved most. */
async function changedSheets(out: string, moving: ViewChange[]): Promise<string[]> {
  const dir = join(out, "sheets");
  const work = join(dir, ".work");
  await rm(dir, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const font = sheetFont();
  const rows: string[] = [];
  for (const change of moving) {
    const widths = Object.entries(change.widths).sort((a, b) => (typeof b[1] === "number" ? b[1] : 2) - (typeof a[1] === "number" ? a[1] : 2));
    const [width] = widths[0]!;
    const before = join(out, "before", "shots", "white", width, `${change.view}.jpg`);
    const after = join(out, "after", "shots", "white", width, `${change.view}.jpg`);
    const row = join(work, `${change.view}-${width}.png`);
    const label = `${change.view}   ${widths.map(([w, value]) => `${w}px ${percent(value)}`).join("   ")}   (before | after | difference)`;
    const scale = width === "1280" ? "50%" : "70%";
    if (existsSync(before) && existsSync(after)) {
      const diff = join(work, `${change.view}-${width}-diff.png`);
      Bun.spawnSync(["compare", "-fuzz", "2%", before, after, "-compose", "src", "-highlight-color", "#ff3b6b", "-lowlight-color", "#1b1b1b", diff]);
      sh(["convert", "-background", "#1b1b1b", "(", before, "-resize", scale, ")", "(", "-size", "12x12", "xc:#1b1b1b", ")", "(", after, "-resize", scale, ")", "(", "-size", "12x12", "xc:#1b1b1b", ")", "(", diff, "-resize", scale, ")", "+append", "+repage", row], { quiet: true });
    } else {
      // A view only one side has (a tab added or gone): that side's picture, on its side of the row.
      const only = existsSync(before) ? before : existsSync(after) ? after : null;
      const blank = ["(", "-size", width === "1280" ? "640x400" : "448x560", "xc:#1b1b1b", ")"];
      if (only) sh(["convert", "-background", "#1b1b1b", ...(only === after ? blank : []), "(", only, "-resize", scale, ")", ...(only === before ? blank : []), "+append", "+repage", row], { quiet: true });
      else sh(["convert", "-size", "640x60", "xc:#1b1b1b", row], { quiet: true });
    }
    sh(["convert", "-background", "#1b1b1b", "-fill", "#e6e6e6", ...font, "-pointsize", "15", `label:${label}`, row, "-gravity", "west", "-append", "+repage", row], { quiet: true });
    rows.push(row);
  }
  const sheets: string[] = [];
  for (let index = 0; index < rows.length; index += SHEET_ROWS) {
    const sheet = join(dir, `changed-${String(index / SHEET_ROWS + 1).padStart(2, "0")}.jpg`);
    sh(["convert", "-background", "#1b1b1b", ...rows.slice(index, index + SHEET_ROWS), "-splice", "0x14", "-append", "+repage", "-quality", "86", sheet], { quiet: true });
    sheets.push(sheet);
  }
  await rm(work, { recursive: true, force: true });
  return sheets;
}

async function report(shardsDir: string, out: string, comment: string | null): Promise<void> {
  const sides = await merge(shardsDir, out);
  const all = await changes(join(out, "before"), join(out, "after"));
  const unsteady = new Set(sides.unsteady);
  const moving = all.filter((change) => moved(change) && !unsteady.has(change.view)).sort((a, b) => worst(b) - worst(a));
  const sheets = await changedSheets(out, moving);
  // The per-family sheets and the audit numbers, for the views a family's change reached.
  Bun.spawnSync(["bun", join(import.meta.dir, "ui-audit-compare.ts"), "--before", join(out, "before"), "--after", join(out, "after"), "--out", join(out, "compare"), "--sheets", "--body-inset", `${BODY_INSET.top},${BODY_INSET.bottom}`], { stdout: "inherit", stderr: "inherit" });
  const failed = (await lines(join(out, "after", "views.jsonl"))).map((line) => JSON.parse(line) as { id: string; view: string }).filter((view) => view.view === "failed").map((view) => view.id.replace(/--failed$/, ""));
  const widths = [...new Set(all.flatMap((change) => Object.keys(change.widths)))].sort((a, b) => Number(a) - Number(b));
  const run = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const md = [
    MARKER,
    `### UI blast radius: ${moving.length} of ${all.length} views changed`,
    "",
    `Base \`${sides.base.slice(0, 9)}\`, head \`${sides.head.slice(0, 9)}\`${sides.dirty ? " with uncommitted changes" : ""}: every function, bundled and registry plugin pane and shell view, Chromium, white theme, ${widths.join(" and ")}px, pane bodies compared (the window's top and bottom ${BODY_INSET.top}px left out). ${sides.offline ? "Data: the week's kept snapshot, offline on both sides." : "Data: fetched once by the base, then read offline by both sides."}`,
    "",
    ...(moving.length
      ? ["| View | " + widths.map((width) => `${width}px`).join(" | ") + " |", "|---|" + widths.map(() => "---:").join("|") + "|",
        ...moving.slice(0, 30).map((change) => `| ${change.view} | ${widths.map((width) => change.widths[width] === undefined ? "" : percent(change.widths[width]!)).join(" | ")} |`),
        ...(moving.length > 30 ? [`| and ${moving.length - 30} more | |`] : [])]
      : ["No pane body moved."]),
    ...(unsteady.size ? ["", `Left out of the count, unsteady (two pictures of the same code differ): ${[...unsteady].sort().join(", ")}.`] : []),
    ...(failed.length ? ["", `Did not open on the head: ${failed.join(", ")}.`] : []),
    "",
    run ? `Sheets (before, after and the difference of every view that moved, and per family): the \`ui-benchmark\` artifact of [this run](${run}).` : `Sheets: ${join(out, "sheets")} (${sheets.length}), ${join(out, "compare", "diff-sheets")}.`,
  ].join("\n");
  await Bun.write(join(out, "summary.md"), `${md}\n`);
  await Bun.write(join(out, "changes.json"), JSON.stringify({ ...sides, views: all.length, changed: moving.length, changedViews: moving.map((change) => change.view), changes: all }, null, 1));
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  if (comment) postComment(comment, join(out, "summary.md"));
}

/** One comment on the pull request, edited in place on every run. */
function postComment(pr: string, bodyFile: string): void {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("--comment needs GITHUB_REPOSITORY");
  const listed = Bun.spawnSync(["gh", "api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", `.[] | select(.body | startswith("${MARKER}")) | .id`]);
  const id = listed.stdout.toString().trim().split("\n").filter(Boolean)[0];
  const args = id
    ? ["gh", "api", "--method", "PATCH", `repos/${repo}/issues/comments/${id}`, "-F", `body=@${bodyFile}`]
    : ["gh", "api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "-F", `body=@${bodyFile}`];
  const posted = Bun.spawnSync(args, { stdout: "ignore", stderr: "inherit" });
  if (posted.exitCode !== 0) console.warn("Could not post the comment (a fork's pull request has a read-only token); the summary is in the run.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = ["shoot", "report"].includes(args[0] ?? "") ? args.shift()! : "all";
  const out = resolve(takeOption(args, "--out") ?? cacheDir("ui-benchmark", "run"));
  if (command === "report") {
    await report(resolve(takeOption(args, "--shards") ?? join(out, "shards")), out, takeOption(args, "--comment") ?? null);
    return;
  }
  const base = takeOption(args, "--base") ?? git(["merge-base", "HEAD", "origin/main"]);
  const options: ShootOptions = {
    base,
    out: command === "all" ? join(out, "shards", "all") : out,
    replay: resolve(takeOption(args, "--replay") ?? cacheDir("ui-benchmark", "replay")),
    widths: takeOption(args, "--widths") ?? "640,1280",
    shard: takeOption(args, "--shard"),
    only: takeOption(args, "--only"),
    offline: args.includes("--offline"),
  };
  await shoot(options);
  if (command === "all") await report(join(out, "shards"), out, null);
}

if (import.meta.main) await main();
