import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { GloomPlugin } from "../../types/plugin";
import type { MarketContext } from "../types";
import { createPaneCatalog } from "./discovery";

const context = { config: createDefaultConfig("/tmp/discovery-test") } as MarketContext;

function plugin(id: string, overrides: Partial<GloomPlugin> = {}): GloomPlugin {
  return { id, name: id, version: "1", setup() {}, ...overrides };
}

test("failed discovery unwinds every started plugin, preserving the setup error", async () => {
  const disposed: string[] = [];
  const failure = new Error("setup failed");
  await expect(createPaneCatalog(context, [
    plugin("first", { dispose() { disposed.push("first"); } }),
    plugin("second", {
      setup() { throw failure; },
      dispose() { disposed.push("second"); throw new Error("dispose failed"); },
    }),
    plugin("never started", { dispose() { disposed.push("never started"); } }),
  ])).rejects.toBe(failure);
  expect(disposed).toEqual(["second", "first"]);
});

test("destroy drains discovery once even when a disposer throws", async () => {
  const disposed: string[] = [];
  const catalog = await createPaneCatalog(context, [
    plugin("first", { dispose() { disposed.push("first"); } }),
    plugin("second", { dispose() { disposed.push("second"); throw new Error("dispose failed"); } }),
  ]);
  expect(() => catalog.destroy()).toThrow("dispose failed");
  expect(() => catalog.destroy()).not.toThrow();
  expect(disposed).toEqual(["second", "first"]);
});
