import { existsSync } from "fs";
import { mkdir, readdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import type { AuditMeasure } from "./ui-audit-measure";
import { FITTED, colourName, variantShape } from "./ui-audit-report";

/**
 * Two UI audit runs side by side (ui-audit.ts): how far the app converged on
 * its conventions, and which views moved.
 *
 *   bun scripts/pane-chrome/ui-audit-compare.ts --before <run> --after <run> [--out <dir>] [--sheets]
 *
 * Writes compare.md and compare.json: per family the variants (shapes, less
 * the colour of their rules, which is a state's or a theme's) before and after,
 * and its looks: the same shapes less what their content or state decides (an
 * icon's width, a weight that marks the active tab or a footer's key), so two
 * key caps that differ by a glyph's width count once, and the font sizes,
 * weights, radii, shadows, rule colours and pane insets in use, with the views
 * only one run measured. `--sheets` also compares every view's picture in
 * both runs (`shots/<theme>/<width>/`, and `<browser>-shots/` beside them)
 * pixel by pixel, and lays out a sheet per family of the views that changed,
 * before over after, with views that did not change beside them.
 *
 * Coverage is explicit: a picture ImageMagick could not read or compare (a
 * truncated file) is an error, a picture with no partner in the other run is
 * listed, and either makes the command exit 1. Neither ever counts as
 * unchanged.
 */

interface ResultLine { id: string; kind: string; token: string; width: number; measure: AuditMeasure }

async function readResults(dir: string): Promise<ResultLine[]> {
  const text = await Bun.file(join(dir, "results.jsonl")).text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ResultLine);
}

/** Families whose weight says which one is active or what the content is, not a variant. */
const WEIGHT_IS_STATE = new Set(["tab", "toggle", "keycap", "pane-footer", "table-header-cell", "legend", "axis", "pane-hint"]);

/** A shape less what its content or state decides. */
function look(family: string, shape: string): string {
  // The audit cuts a long shadow short, so two of the same can read differently past their first offsets.
  let out = shape
    .replace(/\bw=\d+\b/, "w=icon")
    .replace(/ icon\b/, "")
    .replace(/shadow=(.{0,14}).*? (?=(?:outline|font)=)/, "shadow=$1 ");
  if (WEIGHT_IS_STATE.has(family)) out = out.replace(/font=(\d+(?:\.\d+)?)\/\d+/, "font=$1");
  return out.replace(/\s+/g, " ").trim();
}

interface Summary {
  views: Set<string>;
  families: Map<string, Map<string, Set<string>>>;
  looks: Map<string, Map<string, Set<string>>>;
  sizes: Map<number, Set<string>>;
  weights: Map<number, Set<string>>;
  radii: Map<string, Set<string>>;
  shadows: Map<string, Set<string>>;
  rules: Map<string, Set<string>>;
  insets: Map<number, Map<number, Set<string>>>;
}

function add<K>(map: Map<K, Set<string>>, key: K, view: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(view);
  map.set(key, set);
}

function summarize(results: ResultLine[]): Summary {
  const summary: Summary = { views: new Set(), families: new Map(), looks: new Map(), sizes: new Map(), weights: new Map(), radii: new Map(), shadows: new Map(), rules: new Map(), insets: new Map() };
  const palette = results.find((result) => Object.keys(result.measure.palette ?? {}).length)?.measure.palette ?? {};
  for (const result of results) {
    const view = result.id;
    summary.views.add(view);
    for (const run of result.measure.texts) {
      if (FITTED.test(run.chain) && !/legend|axis/i.test(run.roles)) continue;
      add(summary.sizes, run.fontSize, view);
      add(summary.weights, run.fontWeight, view);
    }
    for (const element of result.measure.elements ?? []) {
      if (element.family === "card" && FITTED.test(element.chain)) continue;
      const byShape = summary.families.get(element.family) ?? new Map<string, Set<string>>();
      summary.families.set(element.family, byShape);
      // A rule's colour is a state (focused or not) or a theme's, not a shape: both runs drop it.
      const shape = variantShape(element).replace(/color\([^)]*\)|rgba?\([^)]*\)/g, "c");
      add(byShape, shape, view);
      const byLook = summary.looks.get(element.family) ?? new Map<string, Set<string>>();
      summary.looks.set(element.family, byLook);
      add(byLook, look(element.family, shape), view);
      const radius = /radius=([\d. ]+?)(?= (?:shadow|outline|font|icon|fill)|$)/.exec(element.shape)?.[1]?.trim();
      if (radius !== undefined) add(summary.radii, radius, view);
      const shadow = /shadow=(.+?) (?:outline=|font=)/.exec(element.shape)?.[1];
      if (shadow) add(summary.shadows, shadow.replace(/color\([^)]*\)/g, "c").replace(/\bc\b/g, "c"), view);
      const border = /border=([\d./]+)/.exec(element.shape)?.[1] ?? "0";
      if (border.split("/").some((width) => width === "1") && element.borderColor) add(summary.rules, colourName(element.borderColor, palette), view);
      const insetLine = shadow && /(?:^|, )(?:c|color\([^)]*\)) 0px (?:-?1px) 0px 0px inset/.test(shadow);
      if (insetLine) add(summary.rules, /color\(/.test(shadow!) ? "mixed hairline" : "token or helper rule", view);
    }
    if (result.kind === "pane" && result.measure.inset) {
      const byValue = summary.insets.get(result.width) ?? new Map<number, Set<string>>();
      summary.insets.set(result.width, byValue);
      add(byValue, Math.round(result.measure.inset.left), view);
    }
  }
  return summary;
}

function shapeCount(summary: Summary, family: string): number {
  return summary.families.get(family)?.size ?? 0;
}

function top<K>(map: Map<K, Set<string>>, count = 12): string {
  return [...map].sort((a, b) => b[1].size - a[1].size).slice(0, count).map(([key, set]) => `${key} (${set.size})`).join(", ");
}

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export type Command = (argv: string[]) => CommandResult;

const spawn: Command = (argv) => {
  try {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * One view's two pictures set side by side. `compared` gives the share of
 * pixels that differ (0 when none do); `resized` when the two are not the same
 * size, so a pixel count says nothing; `error` when either picture could not
 * be read or compared. An error is never a 0.
 */
export type PixelComparison =
  | { status: "compared"; change: number }
  | { status: "resized"; before: string; after: string }
  | { status: "error"; error: string };

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** A picture's size; ImageMagick's warnings (a truncated JPEG) count as failures. */
function dimensions(file: string, command: Command): { width: number; height: number } | { error: string } {
  const result = command(["identify", "-regard-warnings", "-format", "%w %h\n", file]);
  if (result.exitCode !== 0) return { error: `identify ${file} failed (exit ${result.exitCode}): ${firstLine(result.stderr) || "no message"}` };
  const match = /^(\d+) (\d+)$/.exec(firstLine(result.stdout));
  const width = Number(match?.[1]), height = Number(match?.[2]);
  if (!match || !(width > 0) || !(height > 0)) return { error: `identify ${file} gave no size: "${firstLine(result.stdout)}"` };
  return { width, height };
}

export function pixelChange(before: string, after: string, command: Command = spawn): PixelComparison {
  const a = dimensions(before, command);
  if ("error" in a) return { status: "error", error: a.error };
  const b = dimensions(after, command);
  if ("error" in b) return { status: "error", error: b.error };
  if (a.width !== b.width || a.height !== b.height) return { status: "resized", before: `${a.width}x${a.height}`, after: `${b.width}x${b.height}` };
  // Exit 0: the same within the fuzz; 1: pixels differ (the count is on stderr); anything else failed.
  const result = command(["compare", "-regard-warnings", "-metric", "AE", "-fuzz", "2%", before, after, "null:"]);
  if (result.exitCode !== 0 && result.exitCode !== 1) return { status: "error", error: `compare failed (exit ${result.exitCode}): ${firstLine(result.stderr) || "no message"}` };
  const text = result.stderr.trim();
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return { status: "error", error: `compare gave no pixel count: "${text.slice(0, 120)}"` };
  return { status: "compared", change: Number(text) / (b.width * b.height) };
}

function run(command: string[]): void {
  const result = spawn(command);
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed (exit ${result.exitCode}): ${firstLine(result.stderr)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const beforeDir = resolve(takeOption(args, "--before") ?? "");
  const afterDir = resolve(takeOption(args, "--after") ?? "");
  const out = resolve(takeOption(args, "--out") ?? afterDir);
  const before = summarize(await readResults(beforeDir));
  const after = summarize(await readResults(afterDir));
  const families = [...new Set([...before.families.keys(), ...after.families.keys()])]
    .sort((a, b) => shapeCount(before, b) - shapeCount(before, a));
  const familyRows = families.map((family) => {
    const shapesAfter = after.families.get(family) ?? new Map<string, Set<string>>();
    const lead = [...shapesAfter].sort((a, b) => b[1].size - a[1].size)[0];
    const off = new Set([...shapesAfter].filter(([shape]) => shape !== lead?.[0]).flatMap(([, views]) => [...views].map((view) => view.split("--")[0]!)));
    return {
      family,
      before: shapeCount(before, family),
      after: shapesAfter.size,
      looksBefore: before.looks.get(family)?.size ?? 0,
      looksAfter: after.looks.get(family)?.size ?? 0,
      looksAfterList: [...(after.looks.get(family) ?? new Map<string, Set<string>>())].sort((a, b) => b[1].size - a[1].size).map(([shape, views]) => ({ shape, functions: [...new Set([...views].map((view) => view.split("--")[0]!))].sort() })),
      offLead: [...off].sort(),
    };
  });
  const scalar = (name: string, b: Map<unknown, Set<string>>, a: Map<unknown, Set<string>>) => ({ name, before: b.size, after: a.size, beforeValues: top(b as Map<string, Set<string>>), afterValues: top(a as Map<string, Set<string>>) });
  const measures = [
    scalar("Font sizes (fitted chart labels left out)", before.sizes, after.sizes),
    scalar("Font weights", before.weights, after.weights),
    scalar("Radii", before.radii, after.radii),
    scalar("Shadows", before.shadows, after.shadows),
    scalar("Colours of 1px rules", before.rules, after.rules),
    ...[...new Set([...before.insets.keys(), ...after.insets.keys()])].sort((x, y) => x - y).map((width) => scalar(`Pane body left inset at ${width}px`, before.insets.get(width) ?? new Map(), after.insets.get(width) ?? new Map())),
  ];
  const md = [
    `# UI audit: before and after`,
    ``,
    `${before.views.size} views before, ${after.views.size} after.`,
    ``,
    `| Family | Variants before | Variants after | Looks before | Looks after | Functions off the main variant after |`,
    `|---|---:|---:|---:|---:|---|`,
    ...familyRows.map((row) => `| ${row.family} | ${row.before} | ${row.after} | ${row.looksBefore} | ${row.looksAfter} | ${row.offLead.length}${row.offLead.length ? `: ${row.offLead.slice(0, 18).join(", ")}${row.offLead.length > 18 ? ", ..." : ""}` : ""} |`),
    ``,
    `## Looks after, per family`,
    ``,
    ...familyRows.flatMap((row) => [
      `### ${row.family}`,
      ``,
      ...row.looksAfterList.map((entry) => `- \`${entry.shape}\`: ${entry.functions.length} (${entry.functions.slice(0, 14).join(", ")}${entry.functions.length > 14 ? ", ..." : ""})`),
      ``,
    ]),
    ``,
    `| Measure | Before | After | Before: values (views) | After: values (views) |`,
    `|---|---:|---:|---|---|`,
    ...measures.map((row) => `| ${row.name} | ${row.before} | ${row.after} | ${row.beforeValues} | ${row.afterValues} |`),
  ];

  // Which views each run measured: a view only one run has is listed, never counted as unchanged.
  const onlyBefore = [...before.views].filter((view) => !after.views.has(view)).sort();
  const onlyAfter = [...after.views].filter((view) => !before.views.has(view)).sort();
  md.splice(3, 0, ``,
    `Views in both runs: ${[...after.views].filter((view) => before.views.has(view)).length}. Only before: ${onlyBefore.length}${onlyBefore.length ? ` (${onlyBefore.join(", ")})` : ""}. Only after: ${onlyAfter.length}${onlyAfter.length ? ` (${onlyAfter.join(", ")})` : ""}.`);

  type Change = { view: string; theme: string; width: string; engine: string } & PixelComparison;
  const changes: Change[] = [];
  const unpaired: Array<{ engine: string; theme: string; width: string; view: string; missing: "before" | "after" }> = [];
  const missingDirs: string[] = [];
  const engineHoles: string[] = [];
  let errors = 0;
  if (args.includes("--sheets")) {
    const listDir = async (dir: string) => existsSync(dir) ? (await readdir(dir)).sort() : [];
    const shotDirs = async (dir: string) => (await listDir(dir)).filter((name) => name === "shots" || /^\w+-shots$/.test(name));
    const dirs = [...new Set([...await shotDirs(beforeDir), ...await shotDirs(afterDir)])];
    for (const dir of dirs) {
      const engine = dir === "shots" ? "chromium" : dir.replace(/-shots$/, "");
      for (const side of [beforeDir, afterDir]) if (!existsSync(join(side, dir))) missingDirs.push(`${engine}: no pictures in the ${side === beforeDir ? "before" : "after"} run (${join(side, dir)})`);
      for (const theme of [...new Set([...await listDir(join(beforeDir, dir)), ...await listDir(join(afterDir, dir))])]) {
        for (const width of [...new Set([...await listDir(join(beforeDir, dir, theme)), ...await listDir(join(afterDir, dir, theme))])]) {
          const beforeFiles = new Set(await listDir(join(beforeDir, dir, theme, width)));
          const afterFiles = new Set(await listDir(join(afterDir, dir, theme, width)));
          for (const file of [...new Set([...beforeFiles, ...afterFiles])].sort()) {
            const view = file.replace(/\.(jpg|png)$/, "");
            if (!beforeFiles.has(file) || !afterFiles.has(file)) {
              unpaired.push({ engine, theme, width, view, missing: beforeFiles.has(file) ? "after" : "before" });
              continue;
            }
            const comparison = pixelChange(join(beforeDir, dir, theme, width, file), join(afterDir, dir, theme, width, file));
            if (comparison.status === "error") errors += 1;
            changes.push({ view, theme, width, engine, ...comparison });
          }
        }
      }
    }
    const moved = (entry: Change) => entry.status === "resized" || (entry.status === "compared" && entry.change > 0.0005);
    const changedViews = new Set(changes.filter(moved).map((entry) => entry.view));
    const failedViews = new Set(changes.filter((entry) => entry.status === "error").map((entry) => entry.view));
    const compared = changes.filter((entry) => entry.status !== "error");
    const byEngine = [...new Set(changes.map((entry) => entry.engine).concat(unpaired.map((entry) => entry.engine)))].map((engine) => {
      const mine = changes.filter((entry) => entry.engine === engine);
      return `| ${engine} | ${mine.filter((entry) => entry.status !== "error").length} | ${mine.filter(moved).length} | ${mine.filter((entry) => entry.status === "error").length} | ${unpaired.filter((entry) => entry.engine === engine && entry.missing === "after").length} | ${unpaired.filter((entry) => entry.engine === engine && entry.missing === "before").length} |`;
    });
    md.push("", "## Pictures compared", "",
      `${compared.length} picture pairs compared, ${errors} could not be compared, ${unpaired.length} pictures without a partner. A pair that could not be compared or has no partner is not counted as unchanged.`, "",
      "| Engine | Pairs compared | Moved (> 0.05% of pixels, or resized) | Could not compare | Only before | Only after |", "|---|---:|---:|---:|---:|---:|", ...byEngine);
    if (missingDirs.length) md.push("", ...missingDirs.map((line) => `- ${line}`));
    // Another engine's pictures against the views Chromium pictured in the same run: a view one engine could not draw is listed.
    for (const dir of dirs.filter((name) => name !== "shots")) {
      for (const [side, sideDir] of [["before", beforeDir], ["after", afterDir]] as const) {
        for (const theme of await listDir(join(sideDir, "shots"))) {
          for (const width of await listDir(join(sideDir, "shots", theme))) {
            const have = new Set(await listDir(join(sideDir, dir, theme, width)));
            const lacking = (await listDir(join(sideDir, "shots", theme, width))).filter((file) => !have.has(file));
            if (lacking.length) engineHoles.push(`${dir.replace(/-shots$/, "")} ${side} ${theme} ${width}: ${lacking.length} of the views Chromium pictured are missing (${lacking.map((file) => file.replace(/\.(jpg|png)$/, "")).join(", ")})`);
          }
        }
      }
    }
    if (engineHoles.length) md.push("", "### Views another engine did not picture", "", ...engineHoles.map((line) => `- ${line}`));
    if (errors) md.push("", "### Could not compare", "", ...changes.filter((entry) => entry.status === "error").map((entry) => `- ${entry.engine} ${entry.theme} ${entry.width} ${entry.view}: ${entry.status === "error" ? entry.error : ""}`));
    if (unpaired.length) md.push("", "### Without a partner", "", ...unpaired.map((entry) => `- ${entry.engine} ${entry.theme} ${entry.width} ${entry.view}: no ${entry.missing} picture`));
    const sheets = join(out, "diff-sheets");
    await rm(sheets, { recursive: true, force: true });
    await mkdir(join(sheets, ".work"), { recursive: true });
    md.push("", "## Views that moved", "", `${changedViews.size} of ${new Set(changes.map((entry) => entry.view)).size} views differ by more than 0.05% of their pixels, or in size, in some engine, theme or width; ${failedViews.size} could not be compared somewhere.`, "");
    const worst = (view: string) => Math.max(0, ...changes.filter((entry) => entry.view === view && entry.status === "compared").map((entry) => entry.status === "compared" ? entry.change : 0));
    for (const family of families) {
      const views = [...(after.families.get(family)?.values() ?? [])].flatMap((set) => [...set]);
      const unique = [...new Set(views)];
      const movedViews = unique.filter((view) => changedViews.has(view) || failedViews.has(view)).sort((x, y) => worst(y) - worst(x)).slice(0, 16);
      const still = unique.filter((view) => !changedViews.has(view) && !failedViews.has(view)).slice(0, 4);
      if (movedViews.length === 0) continue;
      const tiles: string[] = [];
      for (const view of [...movedViews, ...still]) {
        const beforeShot = join(beforeDir, "shots", "white", "1280", `${view}.jpg`);
        const afterShot = join(afterDir, "shots", "white", "1280", `${view}.jpg`);
        if (!existsSync(beforeShot) || !existsSync(afterShot)) continue;
        const tile = join(sheets, ".work", `${family}-${view}.jpg`);
        try {
          run(["convert", beforeShot, "-resize", "560x", afterShot, "-resize", "560x", "-background", "#202020", "-splice", "0x0", "-append", tile]);
        } catch {
          continue;
        }
        const label = failedViews.has(view) ? "could not compare" : changedViews.has(view) ? `moved ${(worst(view) * 100).toFixed(1)}%` : "unchanged";
        tiles.push("-label", `${view}  ${label}`, tile);
      }
      if (tiles.length === 0) continue;
      run(["montage", ...tiles, "-tile", "4x", "-geometry", "+8+8", "-background", "#1b1b1b", "-fill", "#e0e0e0", "-font", "JetBrains-Mono", "-pointsize", "11", "-title", `${family}: before above after, white 1280px`, join(sheets, `${family}.jpg`)]);
    }
    await rm(join(sheets, ".work"), { recursive: true, force: true });
  }
  await mkdir(out, { recursive: true });
  await Bun.write(join(out, "compare.md"), `${md.join("\n")}\n`);
  await Bun.write(join(out, "compare.json"), JSON.stringify({ views: { onlyBefore, onlyAfter }, families: familyRows, measures, changes, unpaired, missingDirs, engineHoles }, null, 1));
  console.log(join(out, "compare.md"));
  if (errors || unpaired.length || missingDirs.length || engineHoles.length) {
    console.error(`${errors} pictures could not be compared, ${unpaired.length} have no partner, ${missingDirs.length} picture folders are missing, ${engineHoles.length} engine runs lack views: see compare.md.`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
