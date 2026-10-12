import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectDomCellMetrics, formatDomCellMetricsAllowlist } from "../../scripts/update-dom-cell-metrics-allowlist";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./dom-cell-metrics-allowlist.json", import.meta.url);
const UPDATE = "bun scripts/update-dom-cell-metrics-allowlist.ts";

test("DOM-only code uses no more terminal cell metrics than it did", async () => {
  const allowlist: Record<string, number> = await Bun.file(ALLOWLIST).json();
  const current = collectDomCellMetrics(ROOT);
  const grown = Object.entries(current)
    .filter(([file, count]) => count > (allowlist[file] ?? 0))
    .map(([file, count]) => `${file}: ${count} (allowed ${allowlist[file] ?? 0})`);
  const shrunk = Object.entries(allowlist)
    .filter(([file, count]) => (current[file] ?? 0) < count)
    .map(([file, count]) => `${file}: ${current[file] ?? 0} (allowlist says ${count})`);
  const failures: string[] = [];
  if (grown.length) {
    failures.push("New terminal cell metrics in DOM-only code:\n" + grown.join("\n")
      + "\nThe desktop and the web lay out in pixels: size boxes with flex, percentages or CSS units, wrap text in CSS and read sizes from the laid-out page (ResizeObserver, getBoundingClientRect). Cells are the terminal renderer's unit; a size counted in cells stops short of the pane by the remainder.");
  }
  if (shrunk.length) {
    failures.push("Fewer cell metrics than the allowlist records:\n" + shrunk.join("\n")
      + `\nRun \`${UPDATE}\` so the allowance goes down with them.`);
  }
  if (failures.length) throw new Error(failures.join("\n\n"));
});

test("the DOM cell metrics allowlist is sorted and names existing files", async () => {
  const text = await Bun.file(ALLOWLIST).text();
  const allowlist: Record<string, number> = JSON.parse(text);
  expect(text, `Run \`${UPDATE}\` to sort the allowlist.`).toBe(formatDomCellMetricsAllowlist(allowlist));
  for (const file of Object.keys(allowlist)) {
    expect(await Bun.file(resolve(ROOT, file)).exists(), `${file} does not exist. Run \`${UPDATE}\`.`).toBe(true);
  }
});
