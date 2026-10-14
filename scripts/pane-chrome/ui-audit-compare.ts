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
 * key caps that differ by a glyph's width count once, and the font sizes, weights, radii, shadows, rule colours and
 * pane insets in use. `--sheets` also compares every view's picture in both
 * runs (`shots/<theme>/<width>/`, and `<browser>-shots/` beside them) pixel
 * by pixel, and lays out a sheet per family of the views that changed, before
 * over after, with views that did not change beside them.
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

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

/** Share of pixels that differ between two pictures of one view, 0 when equal. */
function pixelChange(before: string, after: string): number {
  const output = run(["compare", "-metric", "AE", "-fuzz", "2%", before, after, "null:"]);
  const differing = Number.parseFloat(output.trim().split(/\s/)[0] ?? "0");
  const size = run(["identify", "-format", "%w %h", after]).split(" ").map(Number);
  return Number.isFinite(differing) && size[0] && size[1] ? differing / (size[0] * size[1]) : 0;
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

  let changes: Array<{ view: string; theme: string; width: string; engine: string; change: number }> = [];
  if (args.includes("--sheets")) {
    const pairs: Array<{ engine: string; dir: string }> = [{ engine: "chromium", dir: "shots" }];
    for (const name of existsSync(afterDir) ? await readdir(afterDir) : []) {
      const match = /^(\w+)-shots$/.exec(name);
      if (match && existsSync(join(beforeDir, name))) pairs.push({ engine: match[1]!, dir: name });
    }
    for (const { engine, dir } of pairs) {
      for (const theme of existsSync(join(afterDir, dir)) ? await readdir(join(afterDir, dir)) : []) {
        for (const width of await readdir(join(afterDir, dir, theme))) {
          for (const file of await readdir(join(afterDir, dir, theme, width))) {
            const beforeFile = join(beforeDir, dir, theme, width, file);
            if (!existsSync(beforeFile)) continue;
            changes.push({ view: file.replace(/\.(jpg|png)$/, ""), theme, width, engine, change: pixelChange(beforeFile, join(afterDir, dir, theme, width, file)) });
          }
        }
      }
    }
    const sheets = join(out, "diff-sheets");
    await rm(sheets, { recursive: true, force: true });
    await mkdir(join(sheets, ".work"), { recursive: true });
    const changedViews = new Set(changes.filter((entry) => entry.change > 0.0005).map((entry) => entry.view));
    md.push("", "## Views that moved", "", `${changedViews.size} of ${new Set(changes.map((entry) => entry.view)).size} views differ by more than 0.05% of their pixels in some engine, theme or width.`, "");
    for (const family of families) {
      const views = [...(after.families.get(family)?.values() ?? [])].flatMap((set) => [...set]);
      const unique = [...new Set(views)];
      const moved = unique.filter((view) => changedViews.has(view)).slice(0, 16);
      const still = unique.filter((view) => !changedViews.has(view)).slice(0, 4);
      if (moved.length === 0) continue;
      const tiles: string[] = [];
      for (const view of [...moved, ...still]) {
        const beforeShot = join(beforeDir, "shots", "white", "1280", `${view}.jpg`);
        const afterShot = join(afterDir, "shots", "white", "1280", `${view}.jpg`);
        if (!existsSync(beforeShot) || !existsSync(afterShot)) continue;
        const tile = join(sheets, ".work", `${family}-${view}.jpg`);
        run(["convert", beforeShot, "-resize", "560x", afterShot, "-resize", "560x", "-background", "#202020", "-splice", "0x0", "-append", tile]);
        const change = Math.max(0, ...changes.filter((entry) => entry.view === view).map((entry) => entry.change));
        tiles.push("-label", `${view}  ${changedViews.has(view) ? `moved ${(change * 100).toFixed(1)}%` : "unchanged"}`, tile);
      }
      if (tiles.length === 0) continue;
      run(["montage", ...tiles, "-tile", "4x", "-geometry", "+8+8", "-background", "#1b1b1b", "-fill", "#e0e0e0", "-font", "JetBrains-Mono", "-pointsize", "11", "-title", `${family}: before above after, white 1280px`, join(sheets, `${family}.jpg`)]);
    }
    await rm(join(sheets, ".work"), { recursive: true, force: true });
  }
  await mkdir(out, { recursive: true });
  await Bun.write(join(out, "compare.md"), `${md.join("\n")}\n`);
  await Bun.write(join(out, "compare.json"), JSON.stringify({ families: familyRows, measures, changes }, null, 1));
  console.log(join(out, "compare.md"));
}

await main();
