import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { Glob } from "bun";
import { join } from "path";
import { selectionStyle, textStyle } from "./host/style";

// WebKit (the macOS app's WKWebView, Safari) ignores the unprefixed
// `user-select`, so a rule written with one spelling leaves interface text
// selectable there while Chrome keeps it plain (GLO-668). Chrome cannot see the
// difference, so the pane chrome checks cannot catch it: this does.

test("every user-select in the stylesheet is also written with the WebKit prefix", () => {
  const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
  const lone: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const plain = [...body!.matchAll(/(?<![-\w])user-select:\s*([\w-]+)/g)].map((match) => match[1]);
    const prefixed = [...body!.matchAll(/-webkit-user-select:\s*([\w-]+)/g)].map((match) => match[1]);
    if (plain.join() !== prefixed.join()) lone.push(selector!.replace(/\s+/g, " ").trim());
  }
  expect(lone).toEqual([]);
});

test("host code sets selection through selectionStyle, which writes both spellings", () => {
  expect(selectionStyle(true)).toEqual({ userSelect: "text", WebkitUserSelect: "text" });
  expect(selectionStyle(false)).toEqual({ userSelect: "none", WebkitUserSelect: "none" });
  // Unset inherits: the page is not selectable, so a run only opts in or out inside a selectable block.
  expect(selectionStyle(undefined)).toEqual({});
  expect(textStyle({ selectable: true }).WebkitUserSelect).toBe("text");
  expect(textStyle({}).WebkitUserSelect).toBeUndefined();

  // Inline `userSelect` anywhere else sits beside its WebKit twin.
  const strays: string[] = [];
  const srcDir = join(import.meta.dir, "../..");
  for (const file of new Glob("**/*.{ts,tsx}").scanSync({ cwd: srcDir })) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file === "renderers/dom/host/style.ts") continue;
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const match of source.matchAll(/\buserSelect\s*:/g)) {
      if (!source.slice(Math.max(0, match.index - 160), match.index + 160).includes("WebkitUserSelect")) strays.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(strays).toEqual([]);
});
