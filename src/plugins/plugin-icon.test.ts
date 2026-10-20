import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readPluginIcon } from "./plugin-icon";

const scratch: string[] = [];

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function plugin(files: Record<string, string | Buffer | Record<string, unknown>>): string {
  const dir = folder("gloom-plugin-icon-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";

function decoded(url: string | null): string | null {
  return url ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString() : null;
}

test("reads the declared icon, else a conventional one beside the entry", () => {
  const declared = plugin({ "gloom.json": { icon: "assets/logo.webp" }, "assets/logo.webp": "webp", "icon.svg": SVG });
  expect(readPluginIcon(declared)?.startsWith("data:image/webp;base64,")).toBe(true);
  expect(decoded(readPluginIcon(declared))).toBe("webp");

  // A declared icon that is missing falls back to the conventional names.
  const missing = plugin({ "gloom.json": { icon: "gone.png" }, "icon.svg": SVG });
  expect(decoded(readPluginIcon(missing))).toBe(SVG);

  expect(readPluginIcon(plugin({ "gloom.json": { id: "plain" } }))).toBeNull();
});

// Root reads a file whatever its mode, so the failed read cannot be made there.
test.skipIf(process.getuid?.() === 0)("a declared icon that cannot be read still falls back to the conventional names", () => {
  const dir = plugin({ "gloom.json": { icon: "logo.png" }, "logo.png": "png", "icon.svg": SVG });
  chmodSync(join(dir, "logo.png"), 0o000);
  expect(decoded(readPluginIcon(dir))).toBe(SVG);
});

test("shows nothing that leaves the checkout, is not an image, or is too large to be a logo", () => {
  const outside = folder("gloom-plugin-icon-outside-");
  writeFileSync(join(outside, "secret.svg"), SVG);

  expect(readPluginIcon(plugin({ "gloom.json": { icon: "../secret.svg" } }))).toBeNull();
  expect(readPluginIcon(plugin({ "gloom.json": { icon: join(outside, "secret.svg") } }))).toBeNull();

  const linked = plugin({ "gloom.json": { id: "linked" } });
  symlinkSync(join(outside, "secret.svg"), join(linked, "icon.svg"));
  expect(readPluginIcon(linked)).toBeNull();

  expect(readPluginIcon(plugin({ "gloom.json": { icon: "package.json" }, "package.json": "{}" }))).toBeNull();
  expect(readPluginIcon(plugin({ "icon.png": Buffer.alloc(256 * 1024 + 1) }))).toBeNull();
});
