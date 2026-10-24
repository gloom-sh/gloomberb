import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const EXCLUDED = [
  "src/plugins/builtin/", "src/sync/", "src/renderers/", "src/components/",
  "src/layout-marketplace/", "src/app.tsx",
];
// Folders inside an excluded one that are already checked; bring the next one in with a line here.
const INCLUDED = [
  "src/plugins/builtin/chart-composer/",
  "src/plugins/builtin/broker-trading/",
  "src/plugins/builtin/account-management/",
  "src/plugins/builtin/cloud/",
  "src/plugins/builtin/notes/",
  "src/plugins/builtin/news/",
  "src/plugins/builtin/custom-view/",
  "src/plugins/builtin/thirteenf/",
  "src/plugins/builtin/buildout/",
  "src/plugins/builtin/dividend-yield/",
  "src/plugins/builtin/exposure/",
  "src/plugins/builtin/trace-bonds/",
  "src/plugins/builtin/market-movers/",
  "src/plugins/builtin/plugin-marketplace/",
  "src/plugins/builtin/alerts/",
  "src/plugins/builtin/sectors/",
  "src/plugins/builtin/holders/",
  "src/plugins/builtin/correlation/",
  "src/plugins/builtin/world-venue-map/",
  "src/plugins/builtin/power/",
  "src/plugins/builtin/earnings/",
  "src/plugins/builtin/futures-curve/",
  "src/plugins/builtin/fx-matrix/",
];

type SilentCatch = {
  file: string;
  line: number;
  column: number;
  kind: "catch" | "promise-catch" | "promise-then";
  code: string;
  scope: "in" | "out";
  folder: string;
  intentional: boolean;
  signature: string;
};

type MarkerProblem = Pick<SilentCatch, "file" | "line" | "column" | "kind" | "scope"> & {
  problem: "reason-too-short" | "logs-and-ignores";
};
type Scan = { sites: SilentCatch[]; markerProblems: MarkerProblem[] };

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

type Constants = {
  declarations: Set<string>;
  bindings: Map<string, { initializer: ts.Expression; scope: ts.Node }>;
};

function constantBindings(source: ts.SourceFile): Constants {
  const declarations = new Set<string>();
  const duplicates = new Set<string>();
  const bindings: Constants["bindings"] = new Map();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
      || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
      || ts.isClassExpression(node) || ts.isEnumDeclaration(node) || ts.isImportClause(node)
      || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        if (declarations.has(node.name.text)) duplicates.add(node.name.text);
        declarations.add(node.name.text);
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isVariableDeclarationList(node.parent)
          && (node.parent.flags & ts.NodeFlags.Const)) {
          const scope = ts.findAncestor(node, (parent) => ts.isBlock(parent) || ts.isSourceFile(parent))!;
          bindings.set(node.name.text, { initializer: node.initializer, scope });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  // Do not mistake a shadowed parameter or inner variable for the constant.
  for (const name of duplicates) bindings.delete(name);
  return { declarations, bindings };
}

function constant(node: ts.Expression, constants: Constants, seen = new Set<string>()): boolean {
  node = unwrap(node);
  if (ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(node)) {
    if (["undefined", "NaN", "Infinity"].includes(node.text) && !constants.declarations.has(node.text)) return true;
    const binding = constants.bindings.get(node.text);
    return !!binding && !seen.has(node.text) && node.pos >= binding.scope.pos && node.end <= binding.scope.end
      && constant(binding.initializer, constants, new Set([...seen, node.text]));
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === "Number" && !constants.declarations.has("Number")) {
    return ["NaN", "POSITIVE_INFINITY", "NEGATIVE_INFINITY", "MAX_VALUE", "MIN_VALUE",
      "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON"].includes(node.name.text);
  }
  if (ts.isPrefixUnaryExpression(node)) return constant(node.operand, constants, seen);
  if (ts.isVoidExpression(node)) return constant(node.expression, constants, seen);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => ts.isOmittedExpression(element) || constant(element, constants, seen));
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) =>
    ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && constant(property.initializer, constants, seen));
  return false;
}

function discardedArgument(node: ts.Expression, parameters: Set<string>, constants: Constants): boolean {
  node = unwrap(node);
  if (!ts.isVoidExpression(node)) return false;
  const expression = unwrap(node.expression);
  return constant(expression, constants) || (ts.isIdentifier(expression) && parameters.has(expression.text));
}

function bindingNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text]
    : name.elements.flatMap((element) => ts.isBindingElement(element) ? bindingNames(element.name) : []);
}

function localReference(node: ts.Expression, parameters: Set<string>, constants: Constants): boolean {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return !parameters.has(node.text);
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return localReference(node.expression, parameters, constants);
  return ts.isElementAccessExpression(node) && localReference(node.expression, parameters, constants)
    && (constant(node.argumentExpression, constants) || localReference(node.argumentExpression, parameters, constants));
}

function cleanup(node: ts.Expression, parameters: Set<string>, constants: Constants): boolean {
  node = unwrap(node);
  // Only straight-line state resets and collection removal: no arbitrary calls,
  // computed work, branching, awaits, or operations that inspect the rejection.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return localReference(node.left, parameters, constants) && constant(node.right, constants);
  }
  if (ts.isDeleteExpression(node)) {
    const target = unwrap(node.expression);
    return (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
      && localReference(target, parameters, constants);
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const { expression, name } = node.expression;
  return localReference(expression, parameters, constants)
    && ((name.text === "clear" && node.arguments.length === 0)
      || (name.text === "delete" && node.arguments.length === 1
        && (constant(node.arguments[0]!, constants) || localReference(node.arguments[0]!, parameters, constants))));
}

function silentBody(body: ts.ConciseBody, parameters: Set<string>, constants: Constants): boolean {
  function silentReturn(expression: ts.Expression | undefined): boolean {
    if (!expression) return true;
    expression = unwrap(expression);
    if (discardedArgument(expression, parameters, constants)) return true;
    return constant(expression, constants);
  }
  if (!ts.isBlock(body)) return silentReturn(body);
  return body.statements.every((statement) => ts.isEmptyStatement(statement)
    || (ts.isReturnStatement(statement) && silentReturn(statement.expression))
    || (ts.isExpressionStatement(statement) && (discardedArgument(statement.expression, parameters, constants)
      || cleanup(statement.expression, parameters, constants))));
}

function intent(body: ts.ConciseBody, source: ts.SourceFile): { present: boolean; valid: boolean; logging: boolean } {
  if (!source.text.slice(body.pos, body.end).includes("Intentional ignore:")) return { present: false, valid: false, logging: false };
  const nested: Array<{ pos: number; end: number }> = [];
  let logging = false;
  function visit(node: ts.Node): void {
    if (node !== body && (ts.isFunctionLike(node) || ts.isCatchClause(node))) {
      nested.push({ pos: node.pos, end: node.end });
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if ((ts.isIdentifier(callee) && callee.text === "logFailure")
        || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && callee.expression.text === "debugLog" && callee.name.text === "createLogger")) logging = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  // Scan trivia, so a string containing the marker cannot excuse a silent catch.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard,
    source.text.slice(body.pos, body.end));
  let present = false;
  let valid = true;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const position = body.pos + scanner.getTokenPos();
    if (nested.some((range) => position >= range.pos && position < range.end)) continue;
    const marker = /^\/[/\*][ \t]*Intentional ignore:([\s\S]*?)(?:\*\/)?$/.exec(scanner.getTokenText());
    if (!marker) continue;
    present = true;
    valid &&= (marker[1]!.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0) >= 4;
  }
  return { present, valid: present && valid, logging };
}

export function scanSilentCatches(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const constants = constantBindings(source);
  const sites: SilentCatch[] = [];
  const markerProblems: MarkerProblem[] = [];
  const included = INCLUDED.find((prefix) => file.startsWith(prefix));
  const excluded = included ? undefined : EXCLUDED.find((prefix) => prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix);
  const folder = included ?? excluded ?? (file.split("/").length > 2 ? `${file.split("/").slice(0, 2).join("/")}/` : "src/");
  function visit(node: ts.Node): void {
    let body: ts.ConciseBody | undefined;
    let parameters = new Set<string>();
    let kind: SilentCatch["kind"] = "catch";
    if (ts.isCatchClause(node)) {
      body = node.block;
      if (node.variableDeclaration) parameters = new Set(bindingNames(node.variableDeclaration.name));
    } else if (ts.isCallExpression(node)) {
      const method = unwrap(node.expression);
      const name = ts.isPropertyAccessExpression(method) ? method.name.text
        : ts.isElementAccessExpression(method) && ts.isStringLiteralLike(method.argumentExpression) ? method.argumentExpression.text : undefined;
      const argument = name === "catch" ? node.arguments[0] : name === "then" ? node.arguments[1] : undefined;
      const callback = argument && unwrap(argument);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        body = callback.body;
        parameters = new Set(callback.parameters.flatMap(({ name }) => bindingNames(name)));
        kind = name === "catch" ? "promise-catch" : "promise-then";
      }
    }
    if (body) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const location = { file, line: position.line + 1, column: position.character + 1, kind, scope: excluded ? "out" as const : "in" as const };
      const marker = intent(body, source);
      if (marker.present && !marker.valid) markerProblems.push({ ...location, problem: "reason-too-short" });
      if (marker.present && marker.logging) markerProblems.push({ ...location, problem: "logs-and-ignores" });
      if (silentBody(body, parameters, constants)) {
        const code = node.getText(source);
        // Token text ignores formatting and comments while retaining literal contents.
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        sites.push({ ...location, code, folder, intentional: marker.valid,
          signature: `${kind}:${createHash("sha256").update(JSON.stringify(tokens)).digest("hex").slice(0, 16)}` });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { sites, markerProblems };
}

export function collectSilentCatches(root = ROOT): Scan {
  const result: Scan = { sites: [], markerProblems: [] };
  for (const file of runtimeFiles(join(root, "src")).sort()) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("catch") && !text.includes("then")) continue;
    const scan = scanSilentCatches(relative(root, file).split(sep).join("/"), text);
    result.sites.push(...scan.sites);
    result.markerProblems.push(...scan.markerProblems);
  }
  return result;
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
  const { sites, markerProblems } = collectSilentCatches(root);
  const inventoryIndex = args.indexOf("--inventory");
  if (inventoryIndex >= 0) {
    const counts: Record<string, { total: number; intentional: number; silent: number }> = {};
    for (const folder of [...EXCLUDED, ...INCLUDED]) counts[folder] = { total: 0, intentional: 0, silent: 0 };
    for (const site of sites) {
      const count = counts[site.folder] ??= { total: 0, intentional: 0, silent: 0 };
      count.total++;
      count[site.intentional ? "intentional" : "silent"]++;
    }
    await Bun.write(resolve(args[inventoryIndex + 1]!), `${JSON.stringify({
      scannerHash: createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"),
      counts, sites, markerProblems,
    }, null, 2)}\n`);
  } else {
    const allowlist: Record<string, string[]> = {};
    for (const site of sites.filter((site) => site.scope === "in" && !site.intentional)) (allowlist[site.file] ??= []).push(site.signature);
    const target = join(root, "src/architecture/silent-catch-allowlist.json");
    await Bun.write(target, formatSilentCatchAllowlist(allowlist));
    console.log(`Wrote ${relative(root, target)} (${Object.values(allowlist).flat().length} sites).`);
  }
}
