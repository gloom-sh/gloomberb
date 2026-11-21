import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Text cut to a count of terminal cells where the desktop and the web can
 * still draw it.
 *
 * The terminal cuts a line that runs past its room at a count of cells. The
 * desktop and the web cut it where its box ends, in CSS (ClippedText,
 * docs/pane-conventions.md "Text that may not fit"): a string already cut to a
 * count of cells ends early there, with room left after its ellipsis, because
 * a glyph is narrower than a cell. This finds every call to a cut that counts
 * cells (and to a function of ours that returns one) outside code only the
 * terminal draws, so `src/architecture/dom-text-cuts.test.ts` can hold the
 * count to what is listed, with why each one stays, and let it only go down.
 *
 * Only the terminal draws:
 * - the terminal renderer and the CLI (TERMINAL_ONLY), the terminal's half of a component and a
 *   pane's headless text (TERMINAL_FILE);
 * - a function or component whose name starts with `terminal`, `Terminal` or `OpenTui`, and a
 *   `cut` given to ClippedText;
 * - the branch a `nativePaneChrome` test (or a name bound to it) leaves to the
 *   terminal: `nativePaneChrome ? whole : cut(...)`, `if (!nativePaneChrome) ...`,
 *   `!nativePaneChrome && ...`, and what follows `if (nativePaneChrome) return ...`.
 *
 * A cut written by hand (`${text.slice(0, width - 1)}…`) counts as one. A
 * function given as a value is not a cut (ClippedText's `cut={truncateWithEllipsis}`
 * hands the terminal its cut), only a call is.
 *
 *   bun scripts/update-dom-text-cuts-allowlist.ts
 */

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST = join(ROOT, "src/architecture/dom-text-cuts-allowlist.json");

/** The cuts that count cells (src/utils/format.ts, src/utils/text-wrap.ts, src/components/ui/table-layout.ts). */
const CELL_CUTS: readonly string[] = [
  "clipKeepingEnd",
  "clipToDisplayWidth",
  "fitTableCellText",
  "fitTableHeaderText",
  "padTo",
  "truncateTextSegments",
  "truncateToDisplayWidth",
  "truncateWithEllipsis",
];

/** Code only the terminal or the CLI runs, and the cuts' own definitions. */
const TERMINAL_ONLY = [
  "src/renderers/opentui/",
  "src/cli/",
  "src/utils/cli-output.ts",
  "src/utils/format.ts",
  "src/utils/text-wrap.ts",
  "src/components/ui/table-layout.ts",
];
/**
 * The terminal's half of a component: an `opentui` folder (src/components/ui/data-table/opentui) or a
 * `terminal.tsx` / `*-terminal.tsx` beside the desktop's (src/layout-marketplace/gallery-terminal.tsx);
 * and a pane's headless text for the CLI (`headless.ts`, `*-headless.ts`).
 */
const TERMINAL_FILE = /\/opentui\/|(?:\/|-)(?:terminal|headless)\.tsx?$/;
const TERMINAL_NAME = /^(?:[Tt]erminal|OpenTui)(?=[A-Z_]|$)/;
const CAPABILITY = "nativePaneChrome";

/** A cut in code the desktop and the web can draw. */
export interface DomTextCut {
  file: string;
  line: number;
  /** The cut called: one of CELL_CUTS, a function of ours that returns one, or HAND_CUT. */
  cut: string;
}

function sourceFiles(dir: string, result: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__snapshots__" || entry.name === "test-support") continue;
      sourceFiles(path, result);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      && !/\.(test|spec)\./.test(entry.name) && !/(?:test-helpers|test-fixture|test-harness|test-utils)\.[^/]+$/.test(entry.name)) {
      result.push(path);
    }
  }
  return result;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Calls that make a component of a function: `memo(function Row() {...})` is still `Row`. */
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

/**
 * The name a function is called by: a declaration's or a named function
 * expression's, or the variable or property an arrow or function expression is
 * set to, directly or through `memo(...)` or `forwardRef(...)`.
 */
function functionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    let parent = node.parent;
    if (ts.isCallExpression(parent) && parent.arguments[0] === node && COMPONENT_WRAPPERS.has(calleeName(parent))) parent = parent.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return null;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

interface Capability {
  /** Names that hold `nativePaneChrome`. */
  native: Set<string>;
  /** Names that hold its negation. */
  terminal: Set<string>;
}

/** The names a file binds to the desktop's capability, or to its negation. */
function capabilityNames(source: ts.SourceFile): Capability {
  const names: Capability = { native: new Set([CAPABILITY]), terminal: new Set() };
  let grew = true;
  while (grew) {
    grew = false;
    const add = (set: Set<string>, name: string) => {
      if (!set.has(name)) {
        set.add(name);
        grew = true;
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        const property = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text;
        if (property === CAPABILITY) add(names.native, node.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const sense = capabilitySense(node.initializer, names);
        if (sense === "native") add(names.native, node.name.text);
        if (sense === "terminal") add(names.terminal, node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

/** Whether an expression is the capability ("native"), its negation ("terminal") or neither. */
function capabilitySense(expression: ts.Expression, names: Capability): "native" | "terminal" | null {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return names.native.has(node.text) ? "native" : names.terminal.has(node.text) ? "terminal" : null;
  if (ts.isPropertyAccessExpression(node) && node.name.text === CAPABILITY) return "native";
  const flip = (sense: "native" | "terminal" | null) => sense === "native" ? "terminal" : sense === "terminal" ? "native" : null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return flip(capabilitySense(node.operand, names));
  // `nativePaneChrome === true`, `nativePaneChrome !== true`, `=== false`.
  if (ts.isBinaryExpression(node) && (node.right.kind === ts.SyntaxKind.TrueKeyword || node.right.kind === ts.SyntaxKind.FalseKeyword)) {
    const operator = node.operatorToken.kind;
    const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
    const unequal = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equal && !unequal) return null;
    const sense = capabilitySense(node.left, names);
    return equal === (node.right.kind === ts.SyntaxKind.TrueKeyword) ? sense : flip(sense);
  }
  return null;
}

/**
 * Whether `condition` being truthy (or, with `whenTruthy` false, falsy) means the
 * terminal: `!nativePaneChrome`, `open && !nativePaneChrome`, or a falsy
 * `nativePaneChrome || wide`.
 */
function meansTerminal(condition: ts.Expression, whenTruthy: boolean, names: Capability): boolean {
  const node = unwrap(condition);
  const sense = capabilitySense(node, names);
  if (sense === (whenTruthy ? "terminal" : "native")) return true;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return meansTerminal(node.operand, !whenTruthy, names);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (whenTruthy && operator === ts.SyntaxKind.AmpersandAmpersandToken) return meansTerminal(node.left, true, names) || meansTerminal(node.right, true, names);
    if (!whenTruthy && operator === ts.SyntaxKind.BarBarToken) return meansTerminal(node.left, false, names) || meansTerminal(node.right, false, names);
  }
  return false;
}

/** A statement that always leaves its block: a return or a throw, or a block that ends in one. */
function leaves(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return last !== undefined && leaves(last);
  }
  return false;
}

/** Whether only the terminal reaches `node`, from what encloses it. */
function terminalOnly(node: ts.Node, names: Capability): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue && meansTerminal(parent.condition, true, names)) return true;
      if (child === parent.whenFalse && meansTerminal(parent.condition, false, names)) return true;
    }
    if (ts.isBinaryExpression(parent) && child === parent.right) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && meansTerminal(parent.left, true, names)) return true;
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && meansTerminal(parent.left, false, names)) return true;
    }
    if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement && meansTerminal(parent.expression, true, names)) return true;
      if (child === parent.elseStatement && meansTerminal(parent.expression, false, names)) return true;
    }
    if ((ts.isBlock(parent) || ts.isSourceFile(parent)) && ts.isStatement(child as ts.Statement)) {
      const statements: readonly ts.Statement[] = parent.statements;
      const index = statements.indexOf(child as ts.Statement);
      for (const earlier of statements.slice(0, Math.max(0, index))) {
        if (ts.isIfStatement(earlier) && !earlier.elseStatement && meansTerminal(earlier.expression, false, names) && leaves(earlier.thenStatement)) return true;
      }
    }
    if (isFunctionLike(parent)) {
      const name = functionName(parent);
      if (name && TERMINAL_NAME.test(name)) return true;
    }
    // ClippedText calls its `cut` in the terminal only.
    if (ts.isJsxAttribute(parent) && ts.isIdentifier(parent.name) && parent.name.text === "cut") return true;
  }
  return false;
}

interface Scanned {
  file: string;
  source: ts.SourceFile;
  names: Capability;
  /** The cut each imported name stands for, by local name. */
  imported: Map<string, string>;
  /** Functions declared in the file, by name. */
  declared: Set<string>;
}

function scanFile(file: string, text: string): Scanned {
  const source = parse(file, text);
  const imported = new Map<string, string>();
  const declared = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) imported.set(node.name.text, (node.propertyName ?? node.name).text);
    const name = isFunctionLike(node) ? functionName(node) : null;
    if (name) declared.add(name);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, source, names: capabilityNames(source), imported, declared };
}

/** The cut a call makes, if it calls one: by the name it is imported, declared or reached as a property under. */
function calledCut(call: ts.CallExpression, scanned: Scanned, cuts: Set<string>, localCuts: Set<string>): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    if (localCuts.has(name)) return name;
    if (scanned.declared.has(name)) return null;
    const original = scanned.imported.get(name);
    if (original !== undefined) return cuts.has(original) ? original : null;
    return CELL_CUTS.includes(name) ? name : null;
  }
  if (ts.isPropertyAccessExpression(callee) && CELL_CUTS.includes(callee.name.text)) return callee.name.text;
  return null;
}

/** The name a hand-written cut is listed under. */
const HAND_CUT = "slice and …";
const ELLIPSIS = /\u2026/;
const SLICES = new Set(["slice", "substring", "substr"]);

/** Whether `node` holds a call that takes part of a string (`.slice(...)`), outside functions inside it. */
function slices(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SLICES.has(node.expression.name.text)) return true;
  if (isFunctionLike(node)) return false;
  return ts.forEachChild(node, slices) ?? false;
}

/**
 * A cut written by hand: a template or a concatenation that puts `…` after
 * part of a string (`${text.slice(0, width - 1)}…`). Counted once, at the
 * outermost concatenation.
 */
function isHandCut(node: ts.Node): boolean {
  if (ts.isTemplateExpression(node)) {
    const pieces = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return pieces.some((piece) => ELLIPSIS.test(piece)) && node.templateSpans.some((span) => slices(span.expression));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
    const operands: ts.Expression[] = [];
    const collect = (expression: ts.Expression) => {
      const inner = unwrap(expression);
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        collect(inner.left);
        collect(inner.right);
      } else operands.push(inner);
    };
    collect(node);
    return operands.some((operand) => (ts.isStringLiteral(operand) || ts.isNoSubstitutionTemplateLiteral(operand)) && ELLIPSIS.test(operand.text))
      && operands.some((operand) => slices(operand));
  }
  return false;
}

/** The cut a node makes: a call to one, or one written by hand. */
function cutAt(node: ts.Node, scanned: Scanned, cuts: Set<string>, localCuts: Set<string>): string | null {
  if (ts.isCallExpression(node)) return calledCut(node, scanned, cuts, localCuts);
  return isHandCut(node) ? HAND_CUT : null;
}

/** The function a node sits in, nearest first. */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let parent = node.parent; parent; parent = parent.parent) if (isFunctionLike(parent)) return parent;
  return null;
}

/**
 * Whether `call` is the string its function returns (the return value or an
 * arrow's body, alone, in a template, a concatenation or one side of a
 * condition), so the function is a cut too. A cut inside the JSX or the object
 * a function returns is that function's own.
 */
function returnedBy(call: ts.Node, fn: ts.FunctionLikeDeclaration): boolean {
  for (let node: ts.Node = call; node.parent; node = node.parent) {
    const parent = node.parent;
    if (parent === fn) return ts.isArrowFunction(fn) && fn.body === node;
    if (ts.isReturnStatement(parent)) return enclosingFunction(parent) === fn;
    const passes = ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent) || ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)
      || (ts.isConditionalExpression(parent) && node !== parent.condition)
      || (ts.isBinaryExpression(parent) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind));
    if (!passes) return false;
  }
  return false;
}

/**
 * Every cut in DOM-reachable code under `root`. A named function that returns
 * a cut is a cut itself: its callers count, not the cuts inside it.
 */
export function collectDomTextCuts(root = ROOT): DomTextCut[] {
  const files = sourceFiles(join(root, "src")).sort().map((path) => toPosix(relative(root, path)))
    .filter((file) => !TERMINAL_ONLY.some((dir) => file.startsWith(dir)) && !TERMINAL_FILE.test(file))
    .map((file) => scanFile(file, readFileSync(join(root, file), "utf8")));
  return findDomTextCuts(files);
}

function findDomTextCuts(files: Scanned[]): DomTextCut[] {
  const cuts = new Set(CELL_CUTS);
  // Functions that return a cut, found until no more turn up (a wrapper of a wrapper).
  const wrappers = new Map<string, Set<string>>(files.map((file) => [file.file, new Set<string>()]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const file of files) {
      const local = wrappers.get(file.file)!;
      const visit = (node: ts.Node) => {
        if (cutAt(node, file, cuts, local) && !terminalOnly(node, file.names)) {
          const fn = enclosingFunction(node);
          const name = fn && functionName(fn);
          if (fn && name && !local.has(name) && returnedBy(node, fn)) {
            local.add(name);
            cuts.add(name);
            grew = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.source);
    }
  }
  const found: DomTextCut[] = [];
  for (const file of files) {
    const local = wrappers.get(file.file)!;
    const visit = (node: ts.Node) => {
      const cut = cutAt(node, file, cuts, local);
      // A wrapper's own cuts, the one it returns and those that build it, are counted where it is called.
      if (cut && !terminalOnly(node, file.names) && !insideWrapper(node, local)) {
        found.push({ file: file.file, line: file.source.getLineAndCharacterOfPosition(node.getStart(file.source)).line + 1, cut });
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
  }
  return found;
}

/** Whether `node` sits in a function of its file that returns a cut. */
function insideWrapper(node: ts.Node, wrappers: Set<string>): boolean {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
    const name = functionName(fn);
    if (name && wrappers.has(name)) return true;
  }
  return false;
}

/** The cuts in source text, for the test's own cases. */
export function findDomTextCutsIn(sources: Record<string, string>): DomTextCut[] {
  return findDomTextCuts(Object.entries(sources).map(([file, text]) => scanFile(file, text)));
}

/** A file allowed its cuts: how many, and why each stays. */
export interface DomTextCutsEntry {
  uses: number;
  why: string;
}

export function countDomTextCuts(cuts: readonly DomTextCut[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cut of cuts) counts[cut.file] = (counts[cut.file] ?? 0) + 1;
  return counts;
}

export function formatDomTextCutsAllowlist(entries: Record<string, DomTextCutsEntry>): string {
  const sorted = Object.fromEntries(Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entry]) => [file, { uses: entry.uses, why: entry.why }]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

if (import.meta.main) {
  const found = collectDomTextCuts();
  const counts = countDomTextCuts(found);
  const previous: Record<string, DomTextCutsEntry> = await Bun.file(ALLOWLIST).exists() ? await Bun.file(ALLOWLIST).json() : {};
  const entries = Object.fromEntries(Object.entries(counts).map(([file, uses]) => [file, { uses, why: previous[file]?.why ?? "" }]));
  if (process.argv.includes("--list")) {
    for (const cut of found) console.log(`${cut.file}:${cut.line} ${cut.cut}`);
  } else {
    await Bun.write(ALLOWLIST, formatDomTextCutsAllowlist(entries));
  }
  const missing = Object.entries(entries).filter(([, entry]) => !entry.why.trim()).map(([file]) => file);
  console.log(`${found.length} cuts to a count of cells in ${Object.keys(counts).length} files the desktop and the web draw`);
  if (missing.length) console.log(`Say in "why" why these stay, or cut by CSS instead:\n${missing.join("\n")}`);
}
