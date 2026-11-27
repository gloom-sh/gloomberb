import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  buildRepoImportGraph,
  selectFloatingPromiseFiles,
  selectTestsForChanges,
  type RepoImportGraph,
} from "./test-scope";
import { compareFloatingPromises, type FloatingPromise } from "./update-floating-promise-allowlist";
import { runtimeFiles } from "./update-silent-catch-allowlist";

function syntheticGraph(overrides: Partial<RepoImportGraph> = {}): RepoImportGraph {
  const testFiles = [
    "scripts/install.test.ts",
    "scripts/nightly.test.ts",
    "scripts/release-workflows.test.ts",
    "src/architecture/ui-literals.test.ts",
    "src/cli/pane-functions/catalog-snapshot.test.ts",
    "src/plugins/builtin/alpha/model.test.ts",
    "src/plugins/builtin/alpha/pane.test.tsx",
    "src/plugins/builtin/beta/pane.test.tsx",
    "src/plugins/catalog-lazy.test.ts",
    "src/public/public-api.test.ts",
  ];
  const sourceFiles = [
    "src/plugins/builtin/alpha/model.ts",
    "src/plugins/builtin/alpha/pane.tsx",
    "src/plugins/builtin/beta/pane.tsx",
    "src/utils/shared.ts",
    "scripts/helper.ts",
  ];
  return {
    allFiles: new Set([...sourceFiles, ...testFiles]),
    testFiles,
    reverseImports: new Map([
      ["src/plugins/builtin/alpha/model.ts", new Set(["src/plugins/builtin/alpha/pane.tsx", "src/plugins/builtin/alpha/model.test.ts"])],
      ["src/plugins/builtin/alpha/pane.tsx", new Set(["src/plugins/builtin/alpha/pane.test.tsx", "src/plugins/builtin/beta/pane.tsx"])],
      ["src/plugins/builtin/beta/pane.tsx", new Set(["src/plugins/builtin/beta/pane.test.tsx"])],
    ]),
    packageExports: new Map(),
    ...overrides,
  };
}

describe("selectTestsForChanges", () => {
  test("skips pure docs and asset changes", () => {
    const graph = syntheticGraph();
    const result = selectTestsForChanges(["docs/checks.md", "README.md", "assets/logo.png"], graph);
    expect(result.mode).toBe("skip");
    expect(result.tests).toEqual([]);
  });

  test("follows transitive reverse imports and includes architecture and catalog checks for plugin files", () => {
    const graph = syntheticGraph();
    const result = selectTestsForChanges(["src/plugins/builtin/alpha/model.ts"], graph);
    expect(result.mode).toBe("scoped");
    expect(result.tests).toEqual([
      "src/architecture/ui-literals.test.ts",
      "src/cli/pane-functions/catalog-snapshot.test.ts",
      "src/plugins/builtin/alpha/model.test.ts",
      "src/plugins/builtin/alpha/pane.test.tsx",
      "src/plugins/builtin/beta/pane.test.tsx",
      "src/plugins/catalog-lazy.test.ts",
    ]);
  });

  test("runs changed test files directly without widening", () => {
    const graph = syntheticGraph();
    const result = selectTestsForChanges(["src/plugins/builtin/alpha/model.test.ts"], graph);
    expect(result.mode).toBe("scoped");
    expect(result.tests).toEqual(["src/plugins/builtin/alpha/model.test.ts"]);
  });

  test("maps workflow edits to release-workflows and nightly tests", () => {
    const graph = syntheticGraph();
    expect(selectTestsForChanges([".github/workflows/pane-chrome.yml"], graph).tests).toEqual([
      "scripts/release-workflows.test.ts",
    ]);
    expect(selectTestsForChanges([".github/workflows/verify-windows.yml"], graph).tests).toEqual([
      "scripts/nightly.test.ts",
      "scripts/release-workflows.test.ts",
    ]);
  });

  test("fails closed on empty diffs, global configs, harnesses, deleted source files, unknown roots, and >250 affected tests", () => {
    const graph = syntheticGraph();
    for (const files of [
      [],
      ["package.json"],
      ["bun.lock"],
      ["tsconfig.json"],
      ["bunfig.toml"],
      [".github/workflows/verify.yml"],
      ["scripts/test-parallel.ts"],
      ["src/test-support/pane.tsx"],
      ["src/plugins/builtin/alpha/deleted.ts"],
      ["Cargo.toml"],
    ]) {
      expect(selectTestsForChanges(files, graph).mode, files.join(",")).toBe("full");
    }

    // Deleting a test file alone does not force a full run.
    expect(selectTestsForChanges(["src/plugins/builtin/alpha/deleted.test.ts"], graph).mode).toBe("skip");

    // Reaching more than 250 test files fails closed to full.
    const manyTests = Array.from({ length: 260 }, (_, index) => `src/many/t${index}.test.ts`);
    const bigGraph = syntheticGraph({
      allFiles: new Set(["src/utils/shared.ts", ...manyTests]),
      testFiles: manyTests,
      reverseImports: new Map([["src/utils/shared.ts", new Set(manyTests)]]),
    });
    expect(selectTestsForChanges(["src/utils/shared.ts"], bigGraph).mode).toBe("full");
  });

  test("narrows real repository plugin edits and fails closed on core utilities", () => {
    const root = resolve(import.meta.dir, "..");
    const graph = buildRepoImportGraph(root);

    const peBand = selectTestsForChanges(["src/plugins/builtin/pe-band/pane.tsx"], graph);
    expect(peBand.mode).toBe("scoped");
    expect(peBand.tests.length).toBeLessThan(35);
    expect(peBand.tests).toContain("src/plugins/builtin/pe-band/pane.test.tsx");
    expect(peBand.tests).toContain("src/architecture/ui-literals.test.ts");
    expect(peBand.tests).toContain("src/cli/pane-functions/catalog-snapshot.test.ts");

    // Cross-plugin imports still propagate across plugin boundaries.
    const changelog = selectTestsForChanges(["src/plugins/builtin/changelog/index.tsx"], graph);
    expect(changelog.mode).toBe("scoped");
    expect(changelog.tests).toContain("src/plugins/builtin/roadmap/pane.test.tsx");

    // Directly editing a catalog registration barrel bypasses the barrier and fails closed.
    expect(selectTestsForChanges(["src/plugins/catalog.ts"], graph).mode).toBe("full");

    const broad = selectTestsForChanges(["src/theme/colors.ts"], graph);
    expect(broad.mode).toBe("full");
  });
});

describe("selectFloatingPromiseFiles and scoped comparison", () => {
  test("includes changed runtime files and transitive runtime callers, skips non-src diffs, and fails closed on config/allowlist/deletions", () => {
    const graph = syntheticGraph();
    const runtime = [
      "src/plugins/builtin/alpha/model.ts",
      "src/plugins/builtin/alpha/pane.tsx",
      "src/plugins/builtin/beta/pane.tsx",
      "src/utils/shared.ts",
    ];

    expect(selectFloatingPromiseFiles(["docs/checks.md", "src/plugins/builtin/alpha/model.test.ts"], graph, runtime)).toMatchObject({
      mode: "skip",
      files: [],
    });

    expect(selectFloatingPromiseFiles(["src/plugins/builtin/alpha/model.ts"], graph, runtime)).toMatchObject({
      mode: "scoped",
      files: [
        "src/plugins/builtin/alpha/model.ts",
        "src/plugins/builtin/alpha/pane.tsx",
        "src/plugins/builtin/beta/pane.tsx",
      ],
    });

    for (const file of [
      "src/architecture/floating-promise-allowlist.json",
      "scripts/update-floating-promise-allowlist.ts",
      "tsconfig.json",
      "package.json",
      "src/plugins/builtin/alpha/removed.ts",
    ]) {
      expect(selectFloatingPromiseFiles([file], graph, runtime).mode, file).toBe("full");
    }
  });

  test("compareFloatingPromises with scopedFiles flags added and stale entries in scoped files without false failures on unscanned files", () => {
    const allowlistText = `${JSON.stringify({
      "src/a.ts": ["void:load()"],
      "src/b.ts": ["void:other()"],
    }, null, 2)}\n`.replace(/\[\n\s+("[^"]+")\n\s+\]/g, "[$1]");
    const site = (file: string, label: string): FloatingPromise => ({
      file,
      line: 1,
      column: 1,
      kind: "void",
      label,
      scope: "in",
      code: `void ${label}`,
    });

    // Scanning only src/a.ts when its allowlisted site is intact passes despite src/b.ts not being scanned.
    expect(compareFloatingPromises([site("src/a.ts", "load()")], allowlistText, new Set(["src/a.ts"]))).toEqual([]);
    // A new floating promise in src/a.ts fails.
    expect(compareFloatingPromises([site("src/a.ts", "load()"), site("src/a.ts", "save()")], allowlistText, new Set(["src/a.ts"])))
      .toEqual([expect.stringContaining("New floating promises:\nsrc/a.ts:1:1 void:save()")]);
    // Removing the allowlisted floating promise in src/a.ts flags the stale entry in src/a.ts only.
    expect(compareFloatingPromises([], allowlistText, new Set(["src/a.ts"])))
      .toEqual([expect.stringContaining("Stale floating promise allowlist entries:\nsrc/a.ts void:load()")]);
  });

  test("resolves real repository runtime files accurately", () => {
    const root = resolve(import.meta.dir, "..");
    const graph = buildRepoImportGraph(root);
    const runtime = runtimeFiles(resolve(root, "src")).map((p) => p.slice(root.length + 1).replace(/\\/g, "/"));
    const result = selectFloatingPromiseFiles(["src/plugins/builtin/pe-band/pane.tsx"], graph, runtime);
    expect(result.mode).toBe("scoped");
    expect(result.files).toContain("src/plugins/builtin/pe-band/pane.tsx");
    expect(result.files.length).toBeLessThan(10);
  });
});
