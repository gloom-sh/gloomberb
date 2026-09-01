import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { dirname, join, relative, resolve } from "path";

const SOURCE_ROOT = process.cwd();
const IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const TYPE_ONLY_PATTERN = /\b(?:import|export)\s+type\s/;

/**
 * Entry points that run in a browser context: the Electrobun desktop view and
 * the hosted web app. Neither has `process`, a filesystem, or a Bun runtime.
 */
const BROWSER_ENTRIES = [
  "src/renderers/electrobun/view/main.tsx",
  "src/renderers/browser/main.tsx",
];

/**
 * Modules that only work under Bun. Each reads the filesystem or the process
 * environment at module scope, so merely importing one from a browser bundle
 * throws on load — the bundle still builds, which is exactly what makes this
 * worth a test.
 *
 * `plugins/loader` reaching the desktop view through `plugins/bundle` shipped a
 * broken desktop build: the view crashed with "Can't find variable: process"
 * before rendering anything, while `desktop:view:build` reported success.
 */
const BUN_ONLY_MODULES = [
  "src/plugins/loader.ts",
  "src/plugins/bundle.ts",
  "src/plugins/seed.ts",
  "src/plugins/host-link.ts",
  "src/cli/restore-plugins.ts",
];

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, ...EXTENSIONS.map((ext) => `${base}${ext}`), ...EXTENSIONS.map((ext) => join(base, `index${ext}`))]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        if (Bun.file(candidate).size >= 0 && !candidate.match(/\/$/)) return candidate;
      } catch {
        // Directory or unreadable entry: keep trying the other candidates.
      }
    }
  }
  return null;
}

/** Walks runtime imports only; `import type` is erased and cannot pull code in. */
async function reachableFrom(entry: string): Promise<Map<string, string[]>> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; path: string[] }> = [{ file: resolve(SOURCE_ROOT, entry), path: [entry] }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = relative(SOURCE_ROOT, current.file);
    if (seen.has(key)) continue;
    seen.set(key, current.path);

    let source: string;
    try {
      source = await Bun.file(current.file).text();
    } catch {
      continue;
    }

    for (const line of source.split("\n")) {
      if (TYPE_ONLY_PATTERN.test(line)) continue;
      for (const match of line.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? match[2] ?? "";
        const resolved = resolveSpecifier(current.file, specifier);
        if (resolved) queue.push({ file: resolved, path: [...current.path, relative(SOURCE_ROOT, resolved)] });
      }
    }
  }

  return seen;
}

describe("browser entry import graph", () => {
  for (const entry of BROWSER_ENTRIES) {
    test(`${entry} does not reach a Bun-only module`, async () => {
      const reachable = await reachableFrom(entry);

      const violations = BUN_ONLY_MODULES
        .filter((module) => reachable.has(module))
        .map((module) => `${module} via ${reachable.get(module)!.slice(-3).join(" -> ")}`);

      expect(violations).toEqual([]);
    });
  }
});
