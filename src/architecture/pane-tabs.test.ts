import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

// A pane's tab strip is chrome: it stays while a tab, a filter or a refresh
// loads, fails or comes back empty (docs/pane-conventions.md, Tabs). A strip
// registered only once data has loaded disappears with every reload, so every
// conditional strip is listed here with the reason the pane has nothing to
// choose between at that moment.
const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./pane-tabs-allowlist.json", import.meta.url);
const SCANNED = ["src/plugins"];
const HOOKS = new Set(["usePaneTabs", "usePaneHeaderTabs"]);

interface Site { file: string; line: number; condition: string }

function sourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, files);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every call whose strip depends on a condition: the condition's text, or the whole argument when it is not a literal. */
function conditionalStrips(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: Site[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text) && node.arguments[0]) {
      let argument = node.arguments[0];
      while (ts.isParenthesizedExpression(argument)) argument = argument.expression;
      if (!ts.isObjectLiteralExpression(argument)) {
        let condition = ts.isConditionalExpression(argument) ? argument.condition : argument;
        while (ts.isParenthesizedExpression(condition)) condition = condition.expression;
        sites.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, condition: normalize(condition.getText(source)) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

test("every conditional tab strip is listed with its reason", async () => {
  const allowlist: Record<string, Record<string, string>> = await Bun.file(ALLOWLIST).json();
  const sites = SCANNED.flatMap((dir) => sourceFiles(resolve(ROOT, dir)))
    .flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return [...HOOKS].some((hook) => text.includes(`${hook}(`)) ? conditionalStrips(relative(ROOT, path).split(sep).join("/"), text) : [];
    });
  const listed = new Set(Object.entries(allowlist).flatMap(([file, conditions]) => Object.keys(conditions).map((condition) => `${file}\n${condition}`)));
  const unlisted = sites.filter((site) => !listed.delete(`${site.file}\n${site.condition}`));
  const failures = [
    ...unlisted.map((site) => `${site.file}:${site.line} registers its tab strip only when \`${site.condition}\`.`),
    ...[...listed].map((key) => `Stale entry in pane-tabs-allowlist.json: ${key.replace("\n", " ")}`),
  ];
  if (failures.length) throw new Error(`${failures.join("\n")}\n\nThe strip stays through loading, failures and empty answers; pass null only for a sign-in or plan wall, no ticker or portfolio yet, or a detail that replaces the tabs by design, and list that condition with its reason in src/architecture/pane-tabs-allowlist.json.`);
});

test("the allowlist gives a reason for every entry", async () => {
  const allowlist: Record<string, Record<string, string>> = await Bun.file(ALLOWLIST).json();
  for (const [file, conditions] of Object.entries(allowlist)) {
    for (const [condition, why] of Object.entries(conditions)) expect(why.trim().length, `${file}: ${condition}`).toBeGreaterThan(10);
  }
});

test("a strip gated on loaded data is found, a literal one is not", () => {
  const sites = conditionalStrips("src/plugins/example.tsx", `
    usePaneTabs({ tabs, activeValue: tab, onSelect });
    usePaneTabs(data ? { tabs, activeValue: tab, onSelect } : null);
    usePaneHeaderTabs((
      years.length > 1
    ) ? { tabs } : null);
    usePaneTabs(options);
  `);
  expect(sites.map((site) => site.condition)).toEqual(["data", "years.length > 1", "options"]);
});
