import { describe, expect, test } from "bun:test";
import { resolvePaneChromeScope } from "./pane-chrome-scope";

describe("resolvePaneChromeScope", () => {
  test("skips chat checks for non-chat chart, table, reader, and builtin plugin edits", () => {
    expect(resolvePaneChromeScope([
      "src/plugins/builtin/clinical-trials/index.tsx",
      "src/components/chart/composite/axis.ts",
      "src/components/ui/data-table/table.tsx",
      "scripts/pane-chrome/axis-checks.ts",
    ]).chatChecks).toBe(false);

    expect(resolvePaneChromeScope([
      "src/plugins/builtin/changelog/index.tsx",
      "src/components/metric-treemap/treemap.tsx",
      "src/remote/pane-screenshot.ts",
      "scripts/pane-chrome/screenshot.ts",
    ]).chatChecks).toBe(false);
  });

  test("runs chat checks when chat, DOM renderer, layout shell, or chat harness files change", () => {
    for (const file of [
      "src/plugins/builtin/chat/index.tsx",
      "src/renderers/dom/index.tsx",
      "src/renderers/electrobun/view/main.tsx",
      "src/components/layout/pane-window.tsx",
      "src/layout/dock.ts",
      "src/ui/scroll-box.tsx",
      "src/components/markdown-text.tsx",
      "scripts/pane-chrome/chat-latency.ts",
      "scripts/pane-chrome/fixture.tsx",
      "scripts/pane-chrome/browser.ts",
      "scripts/pane-chrome/pane-chrome-scope.ts",
      ".github/workflows/pane-chrome.yml",
      ".github/actions/install-webkit/action.yml",
      "package.json",
    ]) {
      expect(resolvePaneChromeScope([file]).chatChecks).toBe(true);
    }
  });

  test("fails closed on empty diffs and unknown paths", () => {
    expect(resolvePaneChromeScope([]).chatChecks).toBe(true);
    expect(resolvePaneChromeScope(["src/new-shared-surface/index.tsx"]).chatChecks).toBe(true);
  });

  test("ignores test-only edits", () => {
    expect(resolvePaneChromeScope([
      "src/plugins/builtin/chat/index.test.tsx",
      "scripts/pane-chrome/pane-chrome-scope.test.ts",
    ]).chatChecks).toBe(false);
  });
});
