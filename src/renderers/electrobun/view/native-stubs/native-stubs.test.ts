import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import * as realKittySupport from "../../../../components/chart/native/kitty/support";
import * as stubKittySupport from "./chart/kitty-support";
import { NativeSurfaceManager as StubNativeSurfaceManager } from "./chart/surface-manager";

// The desktop view bundle aliases these modules to the stubs in this directory
// (see build-assets.ts COMMON_ALIAS_RULES). A method the app calls but the stub
// lacks is a desktop startup crash, not a type error, so check the shapes here.

function exportedFunctions(module: Record<string, unknown>): string[] {
  return Object.keys(module)
    .filter((name) => typeof module[name] === "function")
    .sort();
}

async function calledSurfaceManagerMethods(): Promise<string[]> {
  const calls = new Set<string>();
  const pattern = /\b\w*[sS]urfaceManager(?:\.current)?\.([a-zA-Z]\w*)\s*\(/g;
  for await (const path of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    if (path.includes("native-stubs") || path.includes("native/surface/manager")) continue;
    for (const match of (await Bun.file(path).text()).matchAll(pattern)) {
      calls.add(match[1]!);
    }
  }
  return [...calls].sort();
}

describe("desktop view native stubs", () => {
  test("surface manager stub answers every method the app calls on it", async () => {
    const called = await calledSurfaceManagerMethods();
    expect(called.length).toBeGreaterThan(3);
    const stub = StubNativeSurfaceManager.prototype as unknown as Record<string, unknown>;
    expect(called.filter((name) => typeof stub[name] !== "function")).toEqual([]);
  });

  test("module stubs export every function of the modules they replace", () => {
    expect(
      exportedFunctions(realKittySupport).filter((name) => !exportedFunctions(stubKittySupport).includes(name)),
    ).toEqual([]);
  });
});
