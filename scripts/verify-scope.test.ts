import { describe, expect, test } from "bun:test";
import { resolveVerifyScope } from "./verify-scope";

describe("verify-scope", () => {
  test("fails closed on empty diffs", () => {
    const result = resolveVerifyScope([]);
    expect(result.coreBinaries).toBe(true);
    expect(result.registryPlugins).toBe(true);
  });

  test("skips core binary builds and registry plugin checks on pure built-in plugin, browser UI, docs, and test PRs", () => {
    const cases: string[][] = [
      ["src/plugins/builtin/econ/pane.tsx", "src/plugins/builtin/econ/pane.test.tsx"],
      ["src/plugins/builtin/ticker-detail/overview-tab.tsx", "src/renderers/dom/styles.css"],
      ["src/renderers/browser/main.tsx", "src/renderers/electrobun/view/main.tsx"],
      ["docs/checks.md", "README.md"],
      ["src/api-client/quotes.ts", "src/sync/controller.ts"],
      ["src/components/command-bar/panel/index.tsx", "src/components/layout/header.tsx"],
      ["src/cli/commands/overview.test.ts", "src/public/public-api.test.ts"],
      ["scripts/pane-chrome/ui-audit.ts", ".github/workflows/ui-tokens.yml"],
    ];
    for (const files of cases) {
      const result = resolveVerifyScope(files);
      expect(result.coreBinaries, files.join(",")).toBe(false);
      expect(result.registryPlugins, files.join(",")).toBe(false);
    }
  });

  test("runs core binary build when CLI, packaging, OpenTUI, plugin host, or dependencies change", () => {
    const triggers = [
      "package.json",
      "bun.lock",
      "patches/@opentui%2Fcore@0.3.2.patch",
      "bin/gloom",
      "src/cli/entry.ts",
      "src/renderers/opentui/render-lib.ts",
      "src/renderers/electrobun/view/cli-pane-shot-entry.tsx",
      "src/plugins/host-modules.ts",
      "src/plugins/catalog-ui.ts",
      "src/public/react.ts",
      "scripts/build.ts",
      ".github/workflows/verify.yml",
    ];
    for (const file of triggers) {
      expect(resolveVerifyScope([file]).coreBinaries, file).toBe(true);
    }
  });

  test("runs registry plugin checks when public host exports, shared kit, types, theme, or host packaging change", () => {
    const triggers = [
      "package.json",
      "bun.lock",
      "src/public/utils.ts",
      "src/types/plugin.ts",
      "src/ui/index.tsx",
      "src/components/index.ts",
      "src/components/ui/button.tsx",
      "src/components/chart/composite/index.tsx",
      "src/theme/colors.ts",
      "src/capabilities/index.ts",
      "src/plugins/host-modules.ts",
      "src/cli/entry.ts",
      "src/renderers/opentui/host.tsx",
      "src/renderers/electrobun/bun/tui-entry.ts",
      "scripts/check-registry-plugins.ts",
      "scripts/build.ts",
      ".github/workflows/verify.yml",
    ];
    for (const file of triggers) {
      expect(resolveVerifyScope([file]).registryPlugins, file).toBe(true);
    }
  });

  test("keeps shared UI kit PRs running registry-plugins while skipping unrelated core binary rebuilds", () => {
    const result = resolveVerifyScope(["src/components/ui/button.tsx"]);
    expect(result.registryPlugins).toBe(true);
    expect(result.coreBinaries).toBe(false);
  });
});
