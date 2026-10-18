import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Type, radius and shadow values written out instead of taken from the design
 * system's tokens (docs/pane-conventions.md, "Design system").
 *
 * The desktop and the web size text, round corners and cast shadows from the
 * tokens in src/renderers/dom/styles.css and src/theme/ui-tokens.ts. This
 * counts, per file, every literal that bypasses them: a font size, a weight
 * other than 400 and 700, a corner radius, a drop shadow, in DOM-only code
 * a grey of its own, and padding, margin or gap in pixels.
 * `src/architecture/ui-literals.test.ts` holds each file to
 * its count in `src/architecture/ui-literals-allowlist.json`, where every entry
 * says why it stays (a data mark, a label fitted to a chart's shape, a page
 * drawn before the app's styles). The count can only go down.
 *
 *   bun scripts/update-ui-literals-allowlist.ts
 */

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST = join(ROOT, "src/architecture/ui-literals-allowlist.json");

/** Where the tokens are defined: the one place their values belong. */
const DEFINITIONS = new Set(["src/theme/ui-tokens.ts", "src/theme/font-scale.ts"]);
/** Code that only draws the desktop and the web, where a grey of its own is a literal too. */
const DOM_ONLY_DIRS = ["src/renderers/dom", "src/renderers/electrobun/view", "src/renderers/browser", "src/renderers/share"];

const PATTERNS: Array<{ kind: string; pattern: RegExp; domOnly?: boolean }> = [
  // fontSize: 13 / "13px" / `${n}px` is not a literal; font-size: 13px in CSS.
  { kind: "font size", pattern: /\bfontSize:\s*(?:["'`]\d|\d)|\bfont-size:\s*\d/g },
  { kind: "font weight", pattern: /\bfontWeight:\s*["'`]?(?:[1235689]00|\d50)\b|\bfont-weight:\s*(?:[1235689]00|\d50)\b/g },
  // Any radius but zero: 0, a token, a percentage of a data mark's own box are fine.
  { kind: "radius", pattern: /\bborderRadius:\s*["'`]?(?:[1-9]\d*(?:\.\d+)?|0?\.\d+)(?:px)?\b|\bborder-radius:\s*(?:[1-9]\d*(?:\.\d+)?|0?\.\d+)px\b/g },
  // A drop shadow: x, y and a blur over 0. Inset hairlines and rings are rules, not elevation.
  { kind: "shadow", pattern: /(?:boxShadow:\s*["'`]|box-shadow:\s*)(?!inset)[^;"'`]*?-?\d+(?:px)?\s+-?\d+px\s+[1-9]\d*px/g },
  // #rgb / #rrggbb with equal channels.
  { kind: "grey", pattern: /#(?:([0-9a-fA-F])\1\1|([0-9a-fA-F]{2})\2\2)\b/g, domOnly: true },
  // Padding, margin or gap written in pixels: a CSS declaration, or a style value in a string
  // ("6px 10px", "-4px"). A bare number may be cells shared with the terminal, so only pixels count.
  { kind: "spacing", pattern: /(?<![\w-])(?:padding|margin|gap)(?:-[a-z]+)?:\s*[^;{}\n]*?(?<![\w.-])-?[1-9]\d*(?:\.\d+)?px|\b(?:padding|margin|gap|rowGap|columnGap)(?:Left|Right|Top|Bottom|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?:\s*["'`][^"'`\n]*?(?<![\w.-])-?[1-9]\d*(?:\.\d+)?px/g },
];

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

/** Comments quote values while explaining them; only code counts. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Literals per file and kind ("radius 3, font size 1"), by path from the repository root. */
export function collectUiLiterals(root = ROOT): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const file of sourceFiles(join(root, "src")).sort()) {
    const path = toPosix(relative(root, file));
    if (DEFINITIONS.has(path) || path.startsWith("src/renderers/opentui/")) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    const domOnly = DOM_ONLY_DIRS.some((dir) => path.startsWith(`${dir}/`));
    for (const { kind, pattern, domOnly: onlyDom } of PATTERNS) {
      if (onlyDom && !domOnly) continue;
      const count = text.match(pattern)?.length ?? 0;
      if (count > 0) (counts[path] ??= {})[kind] = count;
    }
  }
  return counts;
}

/** An allowed file: its literals by kind, and why they stay. */
export interface UiLiteralsEntry {
  literals: Record<string, number>;
  why: string;
}

export function formatUiLiteralsAllowlist(entries: Record<string, UiLiteralsEntry>): string {
  const sorted = Object.fromEntries(Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entry]) => [file, {
      literals: Object.fromEntries(Object.entries(entry.literals).sort(([a], [b]) => a.localeCompare(b))),
      why: entry.why,
    }]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

if (import.meta.main) {
  const previous: Record<string, UiLiteralsEntry> = await Bun.file(ALLOWLIST).exists() ? await Bun.file(ALLOWLIST).json() : {};
  const current = collectUiLiterals();
  const next = Object.fromEntries(Object.entries(current).map(([file, literals]) => [file, { literals, why: previous[file]?.why ?? "" }]));
  await Bun.write(ALLOWLIST, formatUiLiteralsAllowlist(next));
  const missing = Object.entries(next).filter(([, entry]) => !entry.why.trim()).map(([file]) => file);
  console.log(`${Object.keys(next).length} files in ${relative(ROOT, ALLOWLIST)}`);
  if (missing.length) console.log(`Say why these stay, or move them onto the tokens:\n${missing.join("\n")}`);
}
