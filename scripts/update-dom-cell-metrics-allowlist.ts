import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Terminal cell metrics in code that only lays out the desktop and the web.
 *
 * The DOM renderer draws in pixels the browser lays out: a pane body, a text
 * column, a scroll range or a list window sized as a count of 8 by 18 pixel
 * cells stops short of the pane by the remainder (GLO-669). Cells stay the
 * terminal renderer's unit. This lists every use of a cell metric in DOM-only
 * code, so `src/architecture/dom-cell-metrics.test.ts` can hold the count to
 * what is already there and let it only go down.
 *
 * DOM-only code: the DOM renderer, the desktop view, the web app and the share
 * pages, and any file that imports the DOM cell size from theme/font-scale.
 *
 *   bun scripts/update-dom-cell-metrics-allowlist.ts
 */

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST = join(ROOT, "src/architecture/dom-cell-metrics-allowlist.json");

const DOM_ONLY_DIRS = [
  "src/renderers/dom",
  "src/renderers/electrobun/view",
  "src/renderers/browser",
  "src/renderers/share",
];
/** Where the DOM cell size is defined: the one place it belongs. */
const DEFINITION = "src/theme/font-scale.ts";
const FONT_SCALE_IMPORT = /from\s+["'][^"']*(?:theme\/font-scale|\.\/font-scale)["']/;
const CELL_METRIC = /\b(?:WEB_CELL_WIDTH|WEB_CELL_HEIGHT|cellWidthPx|cellHeightPx|cellMetrics|charWidth|toCellX|toCellY)\b|\bcell(?:Width|Height)\(|--cell-[wh]\b/g;

function sourceFiles(dir: string, result: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__snapshots__") continue;
      sourceFiles(path, result);
    } else if (entry.isFile() && /\.(tsx?|css)$/.test(entry.name) && !entry.name.includes(".test.") && !entry.name.includes("test-utils")) {
      result.push(path);
    }
  }
  return result;
}

/** Comments name the unit while explaining it; only code counts. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Uses of a cell metric per DOM-only file, by path from the repository root. */
export function collectDomCellMetrics(root = ROOT): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(join(root, "src")).sort()) {
    const path = toPosix(relative(root, file));
    if (path === DEFINITION || path.startsWith("src/renderers/opentui/")) continue;
    const text = readFileSync(file, "utf8");
    const domOnly = DOM_ONLY_DIRS.some((dir) => path.startsWith(`${dir}/`)) || FONT_SCALE_IMPORT.test(text);
    if (!domOnly) continue;
    const count = stripComments(text).match(CELL_METRIC)?.length ?? 0;
    if (count > 0) counts[path] = count;
  }
  return counts;
}

export function formatDomCellMetricsAllowlist(counts: Record<string, number>): string {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

if (import.meta.main) {
  const counts = collectDomCellMetrics();
  await Bun.write(ALLOWLIST, formatDomCellMetricsAllowlist(counts));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`${total} uses of a cell metric in ${Object.keys(counts).length} DOM-only files written to ${relative(ROOT, ALLOWLIST)}`);
}
