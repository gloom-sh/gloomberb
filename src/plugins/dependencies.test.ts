import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { missingPluginDependencies } from "./dependencies";

test("lists declared packages absent from node_modules, scoped ones included", () => {
  const dir = mkdtempSync(join(tmpdir(), "gloom-plugin-deps-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    dependencies: { typebox: "1.1.38", "@earendil-works/pi-ai": "0.81.1", ajv: "8.17.1" },
    peerDependencies: { gloomberb: ">=0.15.0", react: ">=19" },
  }));
  mkdirSync(join(dir, "node_modules", "ajv"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "ajv", "package.json"), "{}");

  expect(missingPluginDependencies(dir)).toEqual(["typebox", "@earendil-works/pi-ai"]);
});

test("a present package whose own dependency is missing counts, as a cut-short install leaves it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gloom-plugin-deps-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-ai": "0.81.1" } }));
  const piAi = join(dir, "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(piAi, { recursive: true });
  writeFileSync(join(piAi, "package.json"), JSON.stringify({ dependencies: { "partial-json": "0.1.7", ajv: "8.17.1" } }));
  mkdirSync(join(dir, "node_modules", "ajv"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "ajv", "package.json"), "{}");

  expect(missingPluginDependencies(dir)).toEqual(["partial-json"]);
});
