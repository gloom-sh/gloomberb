import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

// A Mac shows keys in Apple's notation (⇧⌘F, ⌃S), everything else spells them
// out (Ctrl+Shift+F), and one formatter decides which: formatChordForHost and
// formatShortcutForHost in src/app/keybindings/labels.ts, useShortcutLabel and
// useActionShortcut in components. A key written as a bare label ("Ctrl+S",
// "Shift+Enter") is data the kit formats where it shows it: a footer hint, a
// button's key, a menu accelerator, a help row. A key written into a sentence
// ("press Ctrl+S to save", "(Shift+L)") never reaches the formatter, so a Mac
// would read "Ctrl+" there. This finds every such sentence; the ones that are
// only ever terminal or CLI text are listed with the reason.
const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./shortcut-labels-allowlist.json", import.meta.url);
/** The formatter itself and the grammar its bindings are written in. */
const EXEMPT_DIRS = ["src/app/keybindings/"];

const MODIFIER = String.raw`(?:CmdOrCtrl|Cmd\/Ctrl|Command|Cmd|Control|Ctrl|Option|Alt|Shift|Super|Meta|Win)\+`;
const NAMES_A_CHORD = new RegExp(`(?<![\\w/])${MODIFIER}`);
/** A whole label: modifiers, then a key or keys (`Left/Right`), nothing else. A template's text may stop at the modifiers. */
const BARE_LABEL = new RegExp(`^(?:${MODIFIER})+[^\\s()]+$`);
const BARE_TEMPLATE_HEAD = new RegExp(`^(?:${MODIFIER})+$`);

interface Sentence { file: string; line: number; text: string }

function sourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__snapshots__") sourceFiles(path, files);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

/** Every string, template piece and JSX text in a file that names a modified key inside other words. */
export function keySentences(file: string, text: string): Sentence[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Sentence[] = [];
  const visit = (node: ts.Node) => {
    let literal: string | null = null;
    let templateHead = false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text;
    else if (ts.isTemplateHead(node)) {
      literal = node.text;
      templateHead = true;
    } else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literal = node.text;
    else if (ts.isJsxText(node)) literal = node.text;
    if (literal !== null && NAMES_A_CHORD.test(literal)) {
      const trimmed = literal.trim();
      const bare = BARE_LABEL.test(trimmed) || (templateHead && BARE_TEMPLATE_HEAD.test(trimmed));
      if (!bare) {
        found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: trimmed });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("no sentence names a modified key past the formatter", async () => {
  const allowlist: Record<string, string> = await Bun.file(ALLOWLIST).json();
  const sentences = sourceFiles(resolve(ROOT, "src"))
    .map((path) => relative(ROOT, path).split(sep).join("/"))
    .filter((file) => !EXEMPT_DIRS.some((dir) => file.startsWith(dir)))
    .flatMap((file) => {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      return NAMES_A_CHORD.test(text) ? keySentences(file, text) : [];
    });
  const listed = new Set(Object.keys(allowlist));
  const unlisted = sentences.filter((sentence) => !allowlist[sentence.file]);
  for (const sentence of sentences) listed.delete(sentence.file);
  const failures = [
    ...unlisted.map((sentence) => `${sentence.file}:${sentence.line} names a key in text: "${sentence.text}"`),
    ...[...listed].map((file) => `Stale entry in shortcut-labels-allowlist.json: ${file}`),
  ];
  if (failures.length) {
    throw new Error(`${failures.join("\n")}\n\nA Mac shows keys as ⇧⌘F, not Cmd+Shift+F. Put the key in through the formatter: tf("press {key} to save", { key: useShortcutLabel()("Ctrl+S") }), or useActionShortcut for a keybinding action. Text only ever shown in a terminal or by the CLI goes in src/architecture/shortcut-labels-allowlist.json with its reason.`);
  }
});

test("the allowlist gives a reason for every file", async () => {
  const allowlist: Record<string, string> = await Bun.file(ALLOWLIST).json();
  for (const [file, why] of Object.entries(allowlist)) expect(why.trim().length, file).toBeGreaterThan(20);
});

test("a key inside a sentence is found, a bare label or a comment is not", () => {
  const found = keySentences("src/example.tsx", `
    // Ctrl+S saves: a comment is not shown.
    const hint = { key: "Ctrl+S", accelerator: "CmdOrCtrl+Shift+F", keys: ["Shift+Left/Right", "Ctrl+P/N"] };
    const pan = \`Shift+\${name}\`;
    const prose = "Run a search, then press Ctrl+S to save it.";
    const title = \`\${count} hidden: Shift+F lists them\`;
    const label = <Text>Close (Cmd+W)</Text>;
  `);
  expect(found.map((sentence) => sentence.text)).toEqual([
    "Run a search, then press Ctrl+S to save it.",
    "hidden: Shift+F lists them",
    "Close (Cmd+W)",
  ]);
});
