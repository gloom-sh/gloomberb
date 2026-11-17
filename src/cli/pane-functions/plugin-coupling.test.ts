import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, normalize } from "path";
import { SELF_CONTAINED_PLUGINS } from "./catalog-snapshot-build";

const SRC = join(import.meta.dir, "..", "..");
const BUILTIN = join(SRC, "plugins", "builtin");

/** Every source file under src, by path, with its text. */
const files = new Map<string, string>();
(function read(directory: string) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) read(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) files.set(path, readFileSync(path, "utf8"));
  }
})(SRC);

function resolveImport(from: string, specifier: string): string | undefined {
  const base = normalize(join(dirname(from), specifier));
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((path) => files.has(path));
}

/** The files a file imports with `import ... from` or `export ... from`, which are the ones loaded with it. */
function importsOf(path: string): Map<string, string> {
  const named = new Map<string, string>();
  for (const match of files.get(path)!.matchAll(/^\s*(?:import|export)\b([^;]*?)\bfrom\s+"(\.[^"]+)"/gms)) {
    const target = resolveImport(path, match[2]!);
    if (!target) continue;
    named.set(`*${target}`, target);
    for (const part of /\{([^}]*)\}/.exec(match[1]!)?.[1]?.split(",") ?? []) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)!.trim();
      if (name) named.set(name, target);
    }
  }
  return named;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let path = pending.pop(); path; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    pending.push(...new Set(importsOf(path).values()));
  }
  return seen;
}

/** The functions a file's `setup` calls that change something outside it: attach, install, watch, set, register, reset. */
const EFFECT = /^(?:attach|install|watch|setup|set[A-Z]|register|init|reset)\w*$/;

function setupEffects(path: string): Map<string, string> {
  const text = files.get(path)!;
  const effects = new Map<string, string>();
  const imported = importsOf(path);
  for (const start of text.matchAll(/(?:async\s+)?\bsetup\s*(?:\([^)]*\)\s*(?::[^{]*)?\{|:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{)/g)) {
    let depth = 0;
    let end = start.index! + start[0].length - 1;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}" && --depth === 0) break;
    }
    for (const call of text.slice(start.index! + start[0].length - 1, end).matchAll(/(?<![\w.])([A-Za-z_]\w*)\(/g)) {
      const target = imported.get(call[1]!);
      if (EFFECT.test(call[1]!) && target) effects.set(call[1]!, target);
    }
  }
  return effects;
}

/** The file that defines each plugin, and the module files it is made of. */
const PLUGINS: Record<string, string> = {
  ownership: join(BUILTIN, "composite", "ownership.ts"),
  news: join(BUILTIN, "news", "index.tsx"),
  screeners: join(BUILTIN, "composite", "screeners.ts"),
};

/** The modules a plugin is made of: the ones its definition file imports from the built-in folder. */
const modulesOf = (entry: string): string[] => [...new Set(importsOf(entry).values())]
  .filter((path) => path.startsWith(BUILTIN) && !path.includes("/composite/") && !path.endsWith("plugin-module.ts") && !path.endsWith("builtin-plugin-meta.ts"));

/** The setup effects of a plugin's own modules, which are defined where the functions their setups call are. */
const ownedEffects = (entry: string): Set<string> => new Set([entry, ...modulesOf(entry)].flatMap((path) => [...setupEffects(path).values()]));

/** Effects of the other plugins' setups that the code a plugin loads reaches, which only those setups leave in place. */
function foreignEffects(entry: string): string[] {
  const mine = ownedEffects(entry);
  const others = new Set(Object.values(PLUGINS).filter((other) => other !== entry).flatMap((other) => [...ownedEffects(other)]));
  const reached = [...reachableFrom(entry)].flatMap((path) => [...setupEffects(path).values()]);
  return [...new Set(reached.filter((target) => !mine.has(target) && others.has(target)))].map((path) => path.replace(SRC, "src"));
}

test("a plugin `fn` sets up alone loads no code that depends on what another plugin's setup leaves behind", () => {
  expect(Object.keys(PLUGINS).sort()).toEqual([...SELF_CONTAINED_PLUGINS].sort());
  for (const [plugin, entry] of Object.entries(PLUGINS)) {
    expect(ownedEffects(entry).size, `${plugin} owns setup effects the check can see`).toBeGreaterThan(0);
    expect([plugin, foreignEffects(entry)]).toEqual([plugin, []]);
  }
});

test("the check sees a plugin that depends on another's setup, as the chart composer does on the FRED cache and 13F persistence", () => {
  const tickerCore = join(BUILTIN, "composite", "ticker-core.ts");
  expect(foreignEffects(tickerCore)).toContain("src/plugins/builtin/thirteenf/api.ts");
  expect(reachableFrom(tickerCore).has(join(SRC, "sources", "gloomberb-cloud", "fred-series.ts"))).toBe(true);
  expect(SELF_CONTAINED_PLUGINS).not.toContain("ticker-core");
});
