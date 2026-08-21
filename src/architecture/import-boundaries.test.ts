import { describe, expect, test } from "bun:test";
import { readdir } from "fs/promises";
import { join, relative } from "path";

const SOURCE_ROOT = join(process.cwd(), "src");
const RUNTIME_EXTENSIONS = new Set([".ts", ".tsx"]);
const IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const OPENTUI_JSX_PATTERN = /<\s*\/?\s*(box|text|scrollbox|input|textarea|span|strong|u)(?=[\s>/])/g;

function isRuntimeSource(path: string): boolean {
  if (path.includes(".test.")) return false;
  if (path.includes("test-helpers.")) return false;
  if (path.includes("__snapshots__")) return false;
  for (const extension of RUNTIME_EXTENSIONS) {
    if (path.endsWith(extension)) return true;
  }
  return false;
}

async function collectSourceFiles(dir: string, result: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(path, result);
      continue;
    }
    if (entry.isFile() && isRuntimeSource(path)) {
      result.push(path);
    }
  }
  return result;
}

async function collectImports(): Promise<Array<{ file: string; specifier: string }>> {
  const files = await collectSourceFiles(SOURCE_ROOT);
  const imports: Array<{ file: string; specifier: string }> = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      imports.push({
        file: relative(process.cwd(), file),
        specifier: match[1] ?? match[2] ?? "",
      });
    }
  }
  return imports;
}

describe("import boundaries", () => {
  test("external renderer packages stay in renderer adapters", async () => {
    const imports = await collectImports();
    const violations = imports.filter(({ file, specifier }) => {
      if (specifier.startsWith("@opentui/") || specifier.startsWith("@opentui-ui/")) {
        return !file.startsWith("src/renderers/opentui/");
      }
      if (specifier.startsWith("#opentui/")) {
        return true;
      }
      if (specifier.startsWith("electrobun/")) {
        return !file.startsWith("src/renderers/electrobun/");
      }
      if (specifier === "react-dom" || specifier.startsWith("react-dom/")) {
        return ![
          "src/renderers/electrobun/",
          "src/renderers/browser/",
          "src/renderers/share/",
        ].some((prefix) => file.startsWith(prefix));
      }
      return false;
    });

    expect(violations).toEqual([]);
  });

  test("core and shared react layers do not import renderer packages directly", async () => {
    const imports = await collectImports();
    const violations = imports.filter(({ file, specifier }) => {
      if (!file.startsWith("src/core/") && !file.startsWith("src/react/")) return false;
      return (
        specifier.startsWith("@opentui/")
        || specifier.startsWith("@opentui-ui/")
        || specifier.startsWith("#opentui/")
        || specifier.startsWith("electrobun/")
        || specifier === "react-dom"
        || specifier.startsWith("react-dom/")
      );
    });

    expect(violations).toEqual([]);
  });

  test("core state stays out of React app context", async () => {
    const imports = await collectImports();
    const violations = imports.filter(({ file, specifier }) => {
      if (!file.startsWith("src/core/")) return false;
      return specifier === "react"
        || specifier.startsWith("react/")
        || specifier.includes("/state/app-context")
        || specifier.endsWith("/state/app-context");
    });

    expect(violations).toEqual([]);
  });

  test("shared runtime code uses Gloom UI components instead of OpenTUI intrinsic tags", async () => {
    const files = await collectSourceFiles(SOURCE_ROOT);
    const violations: Array<{ file: string; tag: string }> = [];

    for (const file of files) {
      const relativeFile = relative(process.cwd(), file);
      if (relativeFile.startsWith("src/renderers/")) continue;

      const source = await Bun.file(file).text();
      for (const match of source.matchAll(OPENTUI_JSX_PATTERN)) {
        violations.push({ file: relativeFile, tag: match[1] ?? "" });
      }
    }

    expect(violations).toEqual([]);
  });
});
