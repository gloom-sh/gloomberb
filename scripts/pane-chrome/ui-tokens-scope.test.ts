import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cacheDir } from "./browser";
import {
  buildBuiltinScopeIndex,
  isNonUiFile,
  resolveUiTokensScope,
  type BuiltinScopeIndex,
} from "./ui-tokens-scope";
import { readCatalog, shardOf } from "./web-app";

function syntheticIndex(overrides: Partial<BuiltinScopeIndex> = {}): BuiltinScopeIndex {
  return {
    sourceFiles: new Set([
      "src/plugins/builtin/alpha/pane.tsx",
      "src/plugins/builtin/alpha/model.ts",
      "src/plugins/builtin/beta/pane.tsx",
      "src/plugins/builtin/beta/helper.ts",
      "src/plugins/builtin/gamma/pane.tsx",
      "src/plugins/builtin/empty-dir/helper.ts",
      "src/plugins/builtin/shared/common.tsx",
      "src/plugins/builtin/cloud/index.tsx",
      "src/components/ui/button.tsx",
    ]),
    reverseImports: new Map([
      ["src/plugins/builtin/alpha/model.ts", new Set(["src/plugins/builtin/alpha/pane.tsx", "src/plugins/builtin/beta/pane.tsx"])],
      ["src/plugins/builtin/beta/helper.ts", new Set(["src/plugins/builtin/shared/common.tsx"])],
      ["src/plugins/builtin/gamma/pane.tsx", new Set(["src/components/ui/button.tsx"])],
    ]),
    dirTokens: new Map([
      ["alpha", new Set(["PEB"])],
      ["beta", new Set(["ECO"])],
      ["gamma", new Set(["GAM"])],
      ["empty-dir", new Set()],
      ["shared", new Set()],
      ["cloud", new Set(["CHAT"])],
    ]),
    fullSweepDirs: new Set(["shared", "composite", "cloud"]),
    ...overrides,
  };
}

describe("ui-tokens-scope", () => {
  test("skips pure non-UI diffs", () => {
    const index = syntheticIndex();
    expect(isNonUiFile("docs/checks.md")).toBe(true);
    expect(isNonUiFile("src/cli/entry.ts")).toBe(true);
    expect(isNonUiFile("src/plugins/builtin/alpha/pane.test.tsx")).toBe(true);
    expect(isNonUiFile("scripts/build-web.ts")).toBe(false);
    expect(isNonUiFile("scripts/pane-chrome/ui-audit.ts")).toBe(false);
    expect(isNonUiFile(".github/workflows/ui-tokens.yml")).toBe(false);
    expect(isNonUiFile(".github/workflows/verify.yml")).toBe(true);

    const result = resolveUiTokensScope([
      "docs/checks.md",
      "README.md",
      "src/cli/commands/overview.ts",
      "src/data/store.ts",
      "src/sync/engine.ts",
      "src/renderers/opentui/host.tsx",
      "src/renderers/electrobun/bun/index.ts",
      "src/plugins/builtin/alpha/pane.test.tsx",
      "scripts/test-parallel.ts",
    ], index);
    expect(result.relevant).toBe(false);
    expect(result.mode).toBe("skip");
    expect(result.only).toEqual([]);
    expect(result.matrixShards).toEqual([]);
  });

  test("scopes single built-in plugin changes to its exact tokens and single runner", () => {
    const index = syntheticIndex();
    const result = resolveUiTokensScope([
      "src/plugins/builtin/alpha/pane.tsx",
      "src/plugins/builtin/alpha/pane.test.tsx",
    ], index);
    expect(result.relevant).toBe(true);
    expect(result.mode).toBe("scoped");
    expect(result.only).toEqual(["PEB"]);
    expect(result.matrixShards).toEqual([1]);
    expect(result.replayShards).toEqual([shardOf("PEB", 2) + 1]);
  });

  test("includes transitive built-in reverse importers and all needed replay shards", () => {
    const index = syntheticIndex();
    const result = resolveUiTokensScope(["src/plugins/builtin/alpha/model.ts"], index);
    expect(result.relevant).toBe(true);
    expect(result.mode).toBe("scoped");
    expect(result.only).toEqual(["ECO", "PEB"]);
    expect(result.matrixShards).toEqual([1]);
    const expectedShards = [...new Set(["ECO", "PEB"].map((token) => shardOf(token, 2) + 1))].sort();
    expect(result.replayShards).toEqual(expectedShards);
  });

  test("fails closed to full sweep for shared kit, theme, CSS, allowlist, workflow, or package files", () => {
    const index = syntheticIndex();
    const fullTriggers = [
      "src/components/ui/button.tsx",
      "src/renderers/dom/styles.css",
      "src/theme/colors.ts",
      "src/architecture/ui-tokens-allowlist.json",
      "scripts/pane-chrome/ui-audit.ts",
      "scripts/build-web.ts",
      "package.json",
      "bun.lock",
      ".github/workflows/ui-tokens.yml",
      "src/plugins/builtin/builtin-plugin-meta.ts",
      "src/plugins/builtin/shared/common.tsx",
      "src/plugins/builtin/cloud/index.tsx",
    ];
    for (const file of fullTriggers) {
      const result = resolveUiTokensScope([file], index);
      expect(result.relevant, file).toBe(true);
      expect(result.mode, file).toBe("full");
      expect(result.only, file).toEqual([]);
      expect(result.matrixShards, file).toEqual([1, 2]);
    }
  });

  test("fails closed when a built-in helper reaches shared/cloud or non-plugin UI", () => {
    const index = syntheticIndex();
    expect(resolveUiTokensScope(["src/plugins/builtin/beta/helper.ts"], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/plugins/builtin/gamma/pane.tsx"], index).mode).toBe("full");
  });

  test("fails closed on empty diffs, unknown built-in dirs, unmapped dirs, CSS in plugins, or deleted files", () => {
    const index = syntheticIndex();
    expect(resolveUiTokensScope([], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/plugins/builtin/unknown-plugin/pane.tsx"], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/plugins/builtin/empty-dir/helper.ts"], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/plugins/builtin/alpha/extra.css"], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/plugins/builtin/alpha/deleted.tsx"], index).mode).toBe("full");
  });

  test("fails closed when affected tokens exceed the single-runner threshold", () => {
    const manyTokens = new Set(Array.from({ length: 25 }, (_, i) => `TOK${i}`));
    const index = syntheticIndex({
      dirTokens: new Map([["alpha", manyTokens]]),
    });
    const result = resolveUiTokensScope(["src/plugins/builtin/alpha/pane.tsx"], index);
    expect(result.mode).toBe("full");
    expect(result.matrixShards).toEqual([1, 2]);
  });

  test("resolves real repository built-in plugins accurately", async () => {
    const root = join(import.meta.dir, "../..");
    const catalog = readCatalog(root, cacheDir("ui-audit-home"));
    const index = await buildBuiltinScopeIndex(root, catalog);

    const peBand = resolveUiTokensScope(["src/plugins/builtin/pe-band/pane.tsx"], index);
    expect(peBand.mode).toBe("scoped");
    expect(peBand.only).toEqual(["PEB"]);
    expect(peBand.matrixShards).toEqual([1]);

    const dividend = resolveUiTokensScope(["src/plugins/builtin/dividend-yield/pane.tsx"], index);
    expect(dividend.mode).toBe("scoped");
    expect(dividend.only).toContain("DVD");
    expect(dividend.only).toContain("T");
    expect(dividend.matrixShards).toEqual([1]);

    const tickerDetail = resolveUiTokensScope(["src/plugins/builtin/ticker-detail/overview-tab.tsx"], index);
    expect(tickerDetail.mode).toBe("scoped");
    expect(tickerDetail.only).toContain("T");
    expect(tickerDetail.only).toContain("foreign-listing");
    expect(tickerDetail.only).toContain("index-history");

    expect(resolveUiTokensScope(["src/plugins/builtin/shared/series-list-detail.tsx"], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/components/ui/button.tsx"], index).mode).toBe("full");
    expect(resolveUiTokensScope(["src/plugins/builtin/not-a-real-plugin/pane.tsx"], index).mode).toBe("full");
  });
});
