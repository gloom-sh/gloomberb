import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectUiLiterals, formatUiLiteralsAllowlist, type UiLiteralsEntry } from "../../scripts/update-ui-literals-allowlist";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./ui-literals-allowlist.json", import.meta.url);
const UPDATE = "bun scripts/update-ui-literals-allowlist.ts";

test("the desktop and the web take type, radii, shadows and greys from the tokens", async () => {
  const allowlist: Record<string, UiLiteralsEntry> = await Bun.file(ALLOWLIST).json();
  const current = collectUiLiterals(ROOT);
  const grown: string[] = [];
  const shrunk: string[] = [];
  for (const file of new Set([...Object.keys(current), ...Object.keys(allowlist)])) {
    const now = current[file] ?? {};
    const allowed = allowlist[file]?.literals ?? {};
    for (const kind of new Set([...Object.keys(now), ...Object.keys(allowed)])) {
      const count = now[kind] ?? 0;
      const limit = allowed[kind] ?? 0;
      if (count > limit) grown.push(`${file}: ${count} ${kind} (allowed ${limit})`);
      if (count < limit) shrunk.push(`${file}: ${count} ${kind} (allowlist says ${limit})`);
    }
  }
  const failures: string[] = [];
  if (grown.length) {
    failures.push("New literal type, radius, shadow or grey values:\n" + grown.join("\n")
      + "\nUse the design system's tokens (docs/pane-conventions.md, \"Design system\"): var(--gloom-type-*), var(--gloom-weight-*), var(--gloom-radius-*), var(--gloom-elevation) and the theme's colour roles, or TYPE, WEIGHT, RADIUS from src/theme/ui-tokens.ts."
      + ` A deliberate exception (a data mark, a label fitted to a chart's shape) goes in the allowlist with its reason: \`${UPDATE}\`.`);
  }
  if (shrunk.length) {
    failures.push("Fewer literals than the allowlist records:\n" + shrunk.join("\n")
      + `\nRun \`${UPDATE}\` so the allowance goes down with them.`);
  }
  if (failures.length) throw new Error(failures.join("\n\n"));
});

test("the UI literals allowlist is sorted, names existing files and says why each stays", async () => {
  const text = await Bun.file(ALLOWLIST).text();
  const allowlist: Record<string, UiLiteralsEntry> = JSON.parse(text);
  expect(text, `Run \`${UPDATE}\` to sort the allowlist.`).toBe(formatUiLiteralsAllowlist(allowlist));
  for (const [file, entry] of Object.entries(allowlist)) {
    expect(await Bun.file(resolve(ROOT, file)).exists(), `${file} does not exist. Run \`${UPDATE}\`.`).toBe(true);
    expect(entry.why.trim(), `${file}: say in "why" why its literals stay (a data mark, a fitted chart label, a page drawn without the app's styles).`).not.toBe("");
  }
});
