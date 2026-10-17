import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const EXCLUDED = [
  "src/plugins/builtin/", "src/sync/", "src/renderers/", "src/components/",
  "src/layout-marketplace/", "src/app.tsx",
];

type SilentCatch = {
  file: string;
  line: number;
  column: number;
  kind: "catch" | "promise-catch";
  code: string;
  scope: "in" | "out";
  folder: string;
  intentional: boolean;
  signature: string;
};

function runtimeFiles(dir: string, result: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__snapshots__" && entry.name !== "test-support") runtimeFiles(path, result);
    } else if (entry.isFile() && /\.tsx?$/.test(path) && !/\.d\.ts$/.test(path)
      && !/\.(test|spec)\./.test(path) && !/(?:test-helpers|test-fixture|test-harness|test-utils)\.[^/]+$/.test(path)) {
      result.push(path);
    }
  }
  return result;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function constant(node: ts.Expression): boolean {
  node = unwrap(node);
  if (ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(node)) return node.text === "undefined";
  if (ts.isPrefixUnaryExpression(node)) return constant(node.operand);
  if (ts.isVoidExpression(node)) return constant(node.expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => ts.isOmittedExpression(element) || constant(element));
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) =>
    ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && constant(property.initializer));
  return false;
}

function discardedArgument(node: ts.Expression, parameters: Set<string>): boolean {
  node = unwrap(node);
  if (!ts.isVoidExpression(node)) return false;
  const expression = unwrap(node.expression);
  return constant(expression) || (ts.isIdentifier(expression) && parameters.has(expression.text));
}

function silentBody(body: ts.ConciseBody, parameters: Set<string>): boolean {
  function silentReturn(expression: ts.Expression | undefined): boolean {
    if (!expression) return true;
    expression = unwrap(expression);
    if (discardedArgument(expression, parameters)) return true;
    return constant(expression);
  }
  if (!ts.isBlock(body)) return silentReturn(body);
  return body.statements.every((statement) => ts.isEmptyStatement(statement)
    || (ts.isReturnStatement(statement) && silentReturn(statement.expression))
    || (ts.isExpressionStatement(statement) && discardedArgument(statement.expression, parameters)));
}

function hasIntent(body: ts.ConciseBody, source: ts.SourceFile): boolean {
  // Scan trivia, so a string containing the marker cannot excuse a silent catch.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard,
    source.text.slice(body.pos, body.end));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if ((token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      && /^\/\/[ \t]*Intentional ignore:[ \t]*\S|^\/\*[ \t]*Intentional ignore:[ \t]*(?!\*\/)\S/.test(scanner.getTokenText())) return true;
  }
  return false;
}

export function scanSilentCatches(file: string, text: string): SilentCatch[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: SilentCatch[] = [];
  const excluded = EXCLUDED.find((prefix) => prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix);
  const folder = excluded ?? (file.split("/").length > 2 ? `${file.split("/").slice(0, 2).join("/")}/` : "src/");
  function visit(node: ts.Node): void {
    let body: ts.ConciseBody | undefined;
    let parameters = new Set<string>();
    let kind: SilentCatch["kind"] = "catch";
    if (ts.isCatchClause(node)) {
      body = node.block;
      if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) parameters.add(node.variableDeclaration.name.text);
    } else if (ts.isCallExpression(node)) {
      const method = unwrap(node.expression);
      const catchCall = (ts.isPropertyAccessExpression(method) && method.name.text === "catch")
        || (ts.isElementAccessExpression(method) && ts.isStringLiteralLike(method.argumentExpression) && method.argumentExpression.text === "catch");
      const callback = node.arguments[0] && unwrap(node.arguments[0]);
      if (catchCall && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        body = callback.body;
        parameters = new Set(callback.parameters.flatMap(({ name }) => ts.isIdentifier(name) ? [name.text] : []));
        kind = "promise-catch";
      }
    }
    if (body && silentBody(body, parameters)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const code = node.getText(source);
      // Token text ignores formatting and comments while retaining literal contents.
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
      const tokens: string[] = [];
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
      sites.push({ file, line: position.line + 1, column: position.character + 1, kind, code,
        scope: excluded ? "out" : "in", folder, intentional: hasIntent(body, source),
        signature: `${kind}:${createHash("sha256").update(JSON.stringify(tokens)).digest("hex").slice(0, 16)}` });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return sites;
}

export function collectSilentCatches(root = ROOT): SilentCatch[] {
  return runtimeFiles(join(root, "src")).sort().flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return text.includes("catch") ? scanSilentCatches(relative(root, file).split(sep).join("/"), text) : [];
  });
}

export function formatSilentCatchAllowlist(allowlist: Record<string, string[]>): string {
  // Keep duplicates: two identical silent catches need two allowances.
  const lines = Object.keys(allowlist).sort().map((file) => `  ${JSON.stringify(file)}: ${JSON.stringify([...allowlist[file]!].sort())}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]!) : ROOT;
  const sites = collectSilentCatches(root);
  const inventoryIndex = args.indexOf("--inventory");
  if (inventoryIndex >= 0) {
    const counts: Record<string, { total: number; intentional: number; silent: number }> = {};
    for (const folder of EXCLUDED) counts[folder] = { total: 0, intentional: 0, silent: 0 };
    for (const site of sites) {
      const count = counts[site.folder] ??= { total: 0, intentional: 0, silent: 0 };
      count.total++;
      count[site.intentional ? "intentional" : "silent"]++;
    }
    await Bun.write(resolve(args[inventoryIndex + 1]!), `${JSON.stringify({
      scannerHash: createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"),
      counts, sites,
    }, null, 2)}\n`);
  } else {
    const allowlist: Record<string, string[]> = {};
    for (const site of sites.filter((site) => site.scope === "in" && !site.intentional)) (allowlist[site.file] ??= []).push(site.signature);
    const target = join(root, "src/architecture/silent-catch-allowlist.json");
    await Bun.write(target, formatSilentCatchAllowlist(allowlist));
    console.log(`Wrote ${relative(root, target)} (${Object.values(allowlist).flat().length} sites).`);
  }
}
