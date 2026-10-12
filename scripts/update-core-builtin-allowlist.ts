import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const ALLOWLIST = join(ROOT, "src/architecture/core-builtin-allowlist.json");

type BuiltinImport = { file: string; plugin: string; specifier: string };

// Keep the runtime source exclusions in sync with import-boundaries.test.ts.
function collectSourceFiles(dir: string, builtinRoot: string, result: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (path === builtinRoot) continue;
    if (entry.isDirectory()) {
      collectSourceFiles(path, builtinRoot, result);
    } else if (entry.isFile()
      && !path.includes(".test.")
      && !path.includes("test-helpers.")
      && !path.includes("__snapshots__")
      && /\.tsx?$/.test(path)) {
      result.push(path);
    }
  }
  return result;
}

export function collectCoreBuiltinImports(root = ROOT): BuiltinImport[] {
  const builtinRoot = join(root, "src/plugins/builtin");
  // shared is a home for shared code, not a specific plugin.
  const plugins = new Set(readdirSync(builtinRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "shared")
    .map((entry) => entry.name));
  const imports: BuiltinImport[] = [];
  for (const file of collectSourceFiles(join(root, "src"), builtinRoot).sort()) {
    const text = readFileSync(file, "utf8");
    // Relative imports from outside this directory must name builtin. Keep
    // character escapes as candidates too, then let the parser decode them.
    if (!text.includes("builtin") && !text.includes("\\")) continue;
    // The syntax tree retains type-only imports and ignores comments and strings.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    function visit(node: ts.Node): void {
      let module: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        module = node.moduleSpecifier;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        module = node.arguments[0];
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        module = node.argument.literal;
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        module = node.moduleReference.expression;
      }
      while (module && ts.isParenthesizedExpression(module)) module = module.expression;
      if (module && ts.isStringLiteralLike(module) && module.text.startsWith(".")) {
        const target = relative(builtinRoot, resolve(dirname(file), module.text));
        const plugin = target.split(sep)[0];
        if (!isAbsolute(target) && plugin && plugins.has(plugin)) {
          imports.push({ file: relative(root, file).split(sep).join("/"), plugin, specifier: module.text });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return imports;
}

export function formatCoreBuiltinAllowlist(allowlist: Record<string, string[]>): string {
  const lines = Object.keys(allowlist).sort().map((file) =>
    `  ${JSON.stringify(file)}: ${JSON.stringify([...new Set(allowlist[file])].sort())}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

if (import.meta.main) {
  const imports = collectCoreBuiltinImports();
  const allowlist: Record<string, string[]> = {};
  for (const { file, plugin } of imports) (allowlist[file] ??= []).push(plugin);
  const formatted = formatCoreBuiltinAllowlist(allowlist);
  await Bun.write(ALLOWLIST, formatted);
  const edges = Object.values(JSON.parse(formatted) as Record<string, string[]>).flat();
  console.log(`Wrote ${relative(ROOT, ALLOWLIST)} (${edges.length} edges in ${Object.keys(allowlist).length} files).`);
  console.log("\n| Plugin | Edges | Files |\n|---|---:|---:|");
  for (const plugin of [...new Set(edges)].sort()) {
    const count = edges.filter((edge) => edge === plugin).length;
    console.log(`| ${plugin} | ${count} | ${count} |`);
  }
}
