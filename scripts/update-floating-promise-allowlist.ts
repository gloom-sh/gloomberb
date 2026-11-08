import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { EXCLUDED, runtimeFiles } from "./update-silent-catch-allowlist";

const ROOT = resolve(import.meta.dir, "..");
const ALLOWLIST = "src/architecture/floating-promise-allowlist.json";
const UPDATE = "bun scripts/update-floating-promise-allowlist.ts";

/**
 * - `statement`: a promise-valued expression statement (`save();`).
 * - `void`: a promise discarded with `void` and nothing else (`void save()`).
 * - `callback`: an arrow that returns a promise to a caller typed to expect
 *   nothing back (`onPress={() => save()}`, `setTimeout(() => save())`).
 */
type Kind = "statement" | "void" | "callback";

export type FloatingPromise = {
  file: string;
  line: number;
  column: number;
  kind: Kind;
  /** The floating expression without arguments or bodies, e.g. `this.store.save()`. */
  label: string;
  scope: "in" | "out";
  code: string;
};

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function parts(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function isPromise(checker: ts.TypeChecker, node: ts.Node, type: ts.Type): boolean {
  // A `then` whose first parameter takes a callback, as on a `PromiseLike`,
  // and a `catch`. A bare `PromiseLike` (the desktop RPC message sends return
  // `void | PromiseLike<void>`) only says when a hand-off happened and has no
  // `.catch` to handle it with.
  for (const part of parts(type)) {
    if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue;
    const apparent = checker.getApparentType(part);
    const then = apparent.getProperty("then");
    if (!then || !apparent.getProperty("catch")) continue;
    for (const thenPart of parts(checker.getTypeOfSymbolAtLocation(then, node))) {
      for (const signature of thenPart.getCallSignatures()) {
        const first = signature.parameters[0];
        if (first && parts(checker.getTypeOfSymbolAtLocation(first, node)).some((value) => value.getCallSignatures().length > 0)) return true;
      }
    }
  }
  return false;
}

function isPromiseArray(checker: ts.TypeChecker, node: ts.Node, type: ts.Type): boolean {
  return (checker.isArrayType(type) || checker.isTupleType(type))
    && checker.getTypeArguments(type as ts.TypeReference).some((element) => isPromise(checker, node, element));
}

function nullish(node: ts.Expression | undefined): boolean {
  if (!node) return true;
  node = unwrap(node);
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined");
}

function methodCall(node: ts.CallExpression): { name: string; receiver: ts.Expression } | undefined {
  const callee = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, receiver: callee.expression };
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return { name: callee.argumentExpression.text, receiver: callee.expression };
  }
  return undefined;
}

function isGlobalPromise(checker: ts.TypeChecker, node: ts.Expression): boolean {
  node = unwrap(node);
  if (!ts.isIdentifier(node) || node.text !== "Promise") return false;
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

/**
 * The part of an expression whose promise is lost when the expression's value
 * is discarded, or undefined when it is handled or holds no promise. Handled:
 * a `.catch(handler)` or `.then(onFulfilled, onRejected)` call, an assignment
 * (whatever reads the target owns the promise), and `Promise.allSettled`, which
 * never rejects. `.finally` passes its receiver's rejection on. A promise passed
 * as an argument belongs to the callee and is not looked at here.
 */
function floating(checker: ts.TypeChecker, node: ts.Expression, callsOnly: boolean): ts.Expression | undefined {
  node = unwrap(node);
  if (ts.isConditionalExpression(node)) {
    return floating(checker, node.whenTrue, callsOnly) ?? floating(checker, node.whenFalse, callsOnly);
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.CommaToken) return floating(checker, node.right, callsOnly) ?? floating(checker, node.left, callsOnly);
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken
      || operator === ts.SyntaxKind.QuestionQuestionToken) return floating(checker, node.right, callsOnly);
    return undefined;
  }
  if (ts.isVoidExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return undefined;
  if (ts.isCallExpression(node)) {
    const call = methodCall(node);
    if (call?.name === "catch" && !nullish(node.arguments[0])) return undefined;
    if (call?.name === "then" && !nullish(node.arguments[1])) return undefined;
    if (call?.name === "allSettled" && isGlobalPromise(checker, call.receiver)) return undefined;
    if (call?.name === "finally" && isPromise(checker, call.receiver, checker.getTypeAtLocation(call.receiver))) {
      return floating(checker, call.receiver, callsOnly) && node;
    }
  } else if (callsOnly && !ts.isNewExpression(node) && !ts.isTaggedTemplateExpression(node)) {
    return undefined;
  }
  const type = checker.getTypeAtLocation(node);
  return isPromise(checker, node, type) || isPromiseArray(checker, node, type) ? node : undefined;
}

function expectsNothingBack(checker: ts.TypeChecker, arrow: ts.ArrowFunction): boolean {
  // Only when every signature the arrow can be called through returns plain
  // `void`: a caller typed `() => void | Promise<void>` or `() => unknown` may
  // wait for the result.
  const contextual = checker.getContextualType(arrow);
  if (!contextual) return false;
  const signatures = parts(contextual).flatMap((part) => part.getCallSignatures());
  return signatures.length > 0 && signatures.every((signature) => {
    const result = checker.getReturnTypeOfSignature(signature);
    return !result.isUnion() && (result.flags & ts.TypeFlags.Void) !== 0;
  });
}

function label(node: ts.Expression): string {
  node = unwrap(node);
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (node.kind === ts.SyntaxKind.SuperKeyword) return "super";
  if (ts.isPropertyAccessExpression(node)) return `${label(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return `${label(node.expression)}[${ts.isStringLiteralLike(key) ? JSON.stringify(key.text) : ""}]`;
  }
  if (ts.isCallExpression(node)) return `${label(node.expression)}()`;
  if (ts.isNewExpression(node)) return `new ${label(node.expression)}()`;
  if (ts.isTaggedTemplateExpression(node)) return `${label(node.tag)}\`\``;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "function";
  return "expression";
}

export function scanFloatingPromises(program: ts.Program, files: readonly string[], root: string): FloatingPromise[] {
  const checker = program.getTypeChecker();
  const sites: FloatingPromise[] = [];
  for (const path of files) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`${path} is not in the program`);
    const file = relative(root, path).split(sep).join("/");
    const scope = EXCLUDED.some((prefix) => file.startsWith(prefix)) ? "out" : "in";
    const add = (kind: Kind, site: ts.Node, expression: ts.Expression) => {
      const position = source.getLineAndCharacterOfPosition(site.getStart(source));
      sites.push({ file, line: position.line + 1, column: position.character + 1, kind, label: label(expression), scope,
        code: site.getText(source).replace(/\s+/g, " ").slice(0, 160) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        const found = floating(checker, node.expression, false);
        if (found) add("statement", node, found);
      } else if (ts.isVoidExpression(node)) {
        const found = floating(checker, node.expression, false);
        if (found) add("void", node, found);
      } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && !node.type) {
        // Calls only: an arrow handing back a stored promise is rare, and
        // asking the type of every concise arrow body would double the run.
        const found = floating(checker, node.body, true);
        if (found && expectsNothingBack(checker, node)) add("callback", node, found);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

export function floatingPromiseProgram(root: string, rootNames: readonly string[], host?: ts.CompilerHost): ts.Program {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  // One program for every runtime: with the DOM library, the terminal, desktop,
  // web and worker files all resolve the types of their calls.
  return ts.createProgram({ rootNames, host,
    options: { ...options, lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], noEmit: true } });
}

function collectFloatingPromises(root: string): FloatingPromise[] {
  const files = runtimeFiles(join(root, "src")).sort();
  return scanFloatingPromises(floatingPromiseProgram(root, files), files, root);
}

function entry(site: Pick<FloatingPromise, "kind" | "label">): string {
  return `${site.kind}:${site.label}`;
}

export function formatFloatingPromiseAllowlist(allowlist: Record<string, string[]>): string {
  // Keep duplicates: two sites with the same call need two allowances.
  const lines = Object.keys(allowlist).sort().map((file) => `  ${JSON.stringify(file)}: ${JSON.stringify([...allowlist[file]!].sort())}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** What fails the check: sites the allowlist does not cover, entries no site uses, and an allowlist out of order. */
export function compareFloatingPromises(sites: readonly FloatingPromise[], text: string): string[] {
  const allowlist: Record<string, string[]> = JSON.parse(text);
  const remaining = new Map<string, number>();
  for (const [file, entries] of Object.entries(allowlist)) {
    for (const value of entries) remaining.set(`${file} ${value}`, (remaining.get(`${file} ${value}`) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const site of sites) {
    if (site.scope !== "in") continue;
    const key = `${site.file} ${entry(site)}`;
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(`${site.file}:${site.line}:${site.column} ${entry(site)}\n  ${site.code}`);
  }
  const stale = [...remaining].filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}${count > 1 ? ` (${count} sites)` : ""}`);
  const failures: string[] = [];
  if (added.length) failures.push(`New floating promises:\n${added.join("\n")}\n`
    + "Await the promise, return it, or end it with `.catch(handler)` that records the failure; `void` alone does not "
    + "handle it. See \"Silent catches and floating promises\" in CONTRIBUTING.md.");
  if (stale.length) failures.push(`Stale floating promise allowlist entries:\n${stale.join("\n")}\nRun \`${UPDATE}\` to remove them.`);
  if (!stale.length && text !== formatFloatingPromiseAllowlist(allowlist)) failures.push(`${ALLOWLIST} is out of order. Run \`${UPDATE}\`.`);
  return failures;
}

function folder(file: string): string {
  const segments = file.split("/");
  const depth = file.startsWith("src/plugins/builtin/") || file.startsWith("src/renderers/") ? 4 : 3;
  return `${segments.slice(0, Math.min(depth, segments.length - 1)).join("/")}/`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]!) : ROOT;
  const started = performance.now();
  const sites = collectFloatingPromises(root);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const target = join(root, ALLOWLIST);
  const inventoryIndex = args.indexOf("--inventory");
  if (args.includes("--check")) {
    const failures = compareFloatingPromises(sites, existsSync(target) ? readFileSync(target, "utf8") : "{}");
    if (failures.length) {
      console.error(failures.join("\n\n"));
      process.exit(1);
    }
    console.log(`No new floating promises (${sites.filter((site) => site.scope === "in").length} allowed, ${seconds} s).`);
  } else if (inventoryIndex >= 0) {
    const counts: Record<string, Record<Kind | "total", number>> = {};
    for (const site of sites) {
      const count = counts[folder(site.file)] ??= { total: 0, statement: 0, void: 0, callback: 0 };
      count.total++;
      count[site.kind]++;
    }
    await Bun.write(resolve(args[inventoryIndex + 1]!), `${JSON.stringify({ seconds: Number(seconds), counts, sites }, null, 2)}\n`);
    console.log(`Wrote ${sites.length} sites (${seconds} s).`);
  } else {
    const allowlist: Record<string, string[]> = {};
    for (const site of sites) if (site.scope === "in") (allowlist[site.file] ??= []).push(entry(site));
    await Bun.write(target, formatFloatingPromiseAllowlist(allowlist));
    console.log(`Wrote ${ALLOWLIST} (${Object.values(allowlist).flat().length} sites, ${seconds} s).`);
  }
}
