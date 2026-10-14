import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, relative, resolve } from "path";

/**
 * The static half of the UI audit: every place in pane, plugin, kit and shell
 * code that sets a visual value itself instead of taking it from the theme or
 * the shared kit. Per file, it counts colour literals (hex, rgb(), hsl(),
 * color-mix()), font sizes, weights, line heights and letter spacing, padding,
 * margin and gaps in CSS units, border widths, radii and shadows, written as
 * literals in style objects, CSS strings or stylesheets. A value read from a
 * CSS variable (`var(--…)`) or a named constant is not counted. Box props in
 * cells (`padding={1}`) are counted apart: the terminal shares them by design.
 *
 *   bun scripts/pane-chrome/ui-audit-static.ts [--out <file.json>] [--extra <dir>]...
 *
 * `--extra` adds plugin checkouts outside this repository (the registry's).
 */

type StaticCategory =
  | "colour" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing"
  | "spacing" | "border" | "radius" | "shadow" | "derivedColour" | "cellProps";

interface StaticFile {
  file: string;
  /** kit, shell, dom-renderer, desktop-view, theme, plugin:<id>, registry:<name>, other */
  area: string;
  counts: Partial<Record<StaticCategory, number>>;
  examples: Partial<Record<StaticCategory, string[]>>;
}

export interface StaticScan {
  files: StaticFile[];
  /** Every distinct literal per category, with how many files use it. */
  values: Record<string, Record<string, number>>;
}

const LITERAL = /(?:\d*\.?\d+\s*(?:px|em|rem|%|ch|vh|vw)\b|#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\()/;

/** `key: value` in an object literal or `key: value;` in CSS; group 1 the key, 2 the value. */
const PROPERTY = /\b(fontSize|font-size|fontWeight|font-weight|lineHeight|line-height|letterSpacing|letter-spacing|(?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?|(?:padding|margin)-(?:top|right|bottom|left|inline|block)|gap|rowGap|columnGap|row-gap|column-gap|border(?:Top|Right|Bottom|Left)?(?:Width)?|border(?:-top|-right|-bottom|-left)?(?:-width)?|borderRadius|border-radius|border(?:Top|Bottom)(?:Left|Right)Radius|boxShadow|box-shadow|outline)\s*:\s*([^,;}\n]+)/g;
const COLOUR = /(["'`])(#[0-9a-fA-F]{3,8})\1|#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(\s*\d|\bcolor-mix\(/g;
const CELL_PROP = /\b((?:padding|margin|gap)(?:X|Y|Top|Right|Bottom|Left)?)=\{\s*(\d+(?:\.\d+)?)\s*\}/g;
/** A colour mixed in place from theme colours: a token the theme does not name. */
const DERIVED = /\b(blendHex|blendForContrast|blendForContrastOnSurfaces|withAlpha|alpha|mixColors?|lighten|darken)\(/g;

function categoryOf(key: string): StaticCategory {
  if (/^font-?[sS]ize$/.test(key)) return "fontSize";
  if (/^font-?[wW]eight$/.test(key)) return "fontWeight";
  if (/^line-?[hH]eight$/.test(key)) return "lineHeight";
  if (/^letter-?[sS]pacing$/.test(key)) return "letterSpacing";
  if (/[rR]adius$/.test(key)) return "radius";
  if (/^box-?[sS]hadow$/.test(key)) return "shadow";
  if (/^(border|outline)/.test(key)) return "border";
  return "spacing";
}

/** Whether a value sets its own number rather than reading a token. */
function literalValue(category: StaticCategory, raw: string): string | null {
  const value = raw.trim().replace(/^["'`]|["'`]$/g, "").trim();
  if (!value || /var\(--/.test(value) && !LITERAL.test(value.replace(/var\([^)]*\)/g, ""))) return null;
  if (category === "fontWeight") return /^["'`]?\d{3}["'`]?$/.test(raw.trim()) || /^(bold|bolder|lighter)$/.test(value) ? value : null;
  if (category === "lineHeight") return /^\d*\.?\d+(px|em|rem)?$/.test(value) ? value : null;
  // A bare number in a style object is px; an identifier or expression is somebody's constant.
  if (/^-?\d*\.?\d+$/.test(raw.trim())) return category === "border" || category === "spacing" || category === "fontSize" || category === "radius" ? `${value}px` : value;
  if (category === "border" && /^(none|0|transparent|inherit)$/.test(value)) return null;
  return LITERAL.test(value) ? value : null;
}

function areaOf(path: string, root: string, extraDirs: readonly string[]): string {
  const rel = relative(root, path).replaceAll("\\", "/");
  const plugin = /^src\/plugins\/builtin\/([^/]+)/.exec(rel);
  if (plugin) return `plugin:${plugin[1]}`;
  const extra = extraDirs.find((dir) => path.startsWith(dir));
  if (extra) return `registry:${extra.replace(/\/+$/, "").split("/").pop()}`;
  if (/^node_modules\/(gloom-[^/]+)/.test(rel)) return `registry:${/^node_modules\/(gloom-[^/]+)/.exec(rel)![1]}`;
  if (/^src\/(components\/ui|ui)\//.test(rel)) return "kit";
  if (/^src\/components\/(layout|command-bar|onboarding)\//.test(rel) || /^src\/app\//.test(rel)) return "shell";
  if (/^src\/components\//.test(rel)) return "shared-components";
  if (/^src\/renderers\/dom\//.test(rel)) return "dom-renderer";
  if (/^src\/renderers\/electrobun\/view\//.test(rel)) return "desktop-view";
  if (/^src\/theme\//.test(rel)) return "theme";
  return "other";
}

/** Code that draws the desktop and web, not the terminal, the CLI or data. */
function scanned(rel: string): boolean {
  if (/\.(test|spec)\.tsx?$|test-harness|test-support|fixtures?\//.test(rel)) return false;
  if (/^src\/(cli|i18n|sources|data|market-data|time-series|renderers\/opentui|renderers\/cloudflare|renderers\/share\/worker|types|public)\//.test(rel)) return false;
  return /\.(tsx?|css)$/.test(rel);
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else out.push(path);
  }
}

export async function scanStatic(root: string, extraDirs: readonly string[] = []): Promise<StaticScan> {
  const paths: string[] = [];
  await walk(join(root, "src"), paths);
  for (const name of ["gloom-polls", "gloom-prediction-markets"]) {
    const dir = join(root, "node_modules", name);
    if (existsSync(dir)) await walk(dir, paths);
  }
  for (const dir of extraDirs) if (existsSync(dir)) await walk(dir, paths);
  const files: StaticFile[] = [];
  const values: Record<string, Record<string, number>> = {};
  for (const path of paths) {
    const rel = relative(root, path).replaceAll("\\", "/");
    if (!scanned(rel.startsWith("..") ? `ext/${path}` : rel)) continue;
    const source = await Bun.file(path).text();
    const counts: StaticFile["counts"] = {};
    const examples: StaticFile["examples"] = {};
    const seenValues = new Map<string, Set<string>>();
    const note = (category: StaticCategory, value: string, line: number, text: string) => {
      counts[category] = (counts[category] ?? 0) + 1;
      const list = examples[category] ??= [];
      if (list.length < 4) list.push(`${line}: ${text.trim().slice(0, 140)}`);
      const set = seenValues.get(category) ?? new Set();
      set.add(value);
      seenValues.set(category, set);
    };
    const lines = source.split("\n");
    let inBlockComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; return; }
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) { inBlockComment = true; return; }
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      const code = line.replace(/\/\/.*$/, "");
      for (const match of code.matchAll(PROPERTY)) {
        const category = categoryOf(match[1]!);
        const value = literalValue(category, match[2]!);
        if (value) note(category, `${match[1]}: ${value}`.slice(0, 80), index + 1, line);
      }
      for (const match of code.matchAll(COLOUR)) note("colour", (match[2] ?? match[0]).slice(0, 40), index + 1, line);
      for (const match of code.matchAll(CELL_PROP)) note("cellProps", `${match[1]}=${match[2]}`, index + 1, line);
      for (const match of code.matchAll(DERIVED)) note("derivedColour", match[1]!, index + 1, line);
    });
    if (Object.keys(counts).length === 0) continue;
    files.push({ file: rel.startsWith("..") ? path : rel, area: areaOf(path, root, extraDirs), counts, examples });
    for (const [category, set] of seenValues) {
      const bucket = values[category] ??= {};
      for (const value of set) bucket[value] = (bucket[value] ?? 0) + 1;
    }
  }
  files.sort((a, b) => total(b) - total(a));
  return { files, values };
}

/** Literals that bypass the tokens; cell props (the terminal's) and derived colours are counted apart. */
export function total(file: StaticFile): number {
  return Object.entries(file.counts).reduce((sum, [category, count]) => sum + (category === "cellProps" || category === "derivedColour" ? 0 : count ?? 0), 0);
}

if (import.meta.main) {
  const { takeOption } = await import("../tui-benchmark-harness");
  const args = process.argv.slice(2);
  const root = resolve(join(import.meta.dir, "../.."));
  const extra = args.flatMap((arg, index) => (arg === "--extra" && args[index + 1] ? [resolve(args[index + 1]!)] : []));
  const scan = await scanStatic(root, extra);
  const out = takeOption(args, "--out");
  if (out) await Bun.write(out, JSON.stringify(scan, null, 1));
  const byArea = new Map<string, number>();
  for (const file of scan.files) byArea.set(file.area, (byArea.get(file.area) ?? 0) + total(file));
  console.log([...byArea].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).map(([area, count]) => `${area}\t${count}`).join("\n"));
  console.log(`\n${scan.files.length} files, ${scan.files.reduce((sum, file) => sum + total(file), 0)} literals`);
}
