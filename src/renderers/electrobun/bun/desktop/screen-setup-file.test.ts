import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { emptyScreenSetup } from "../../../desktop/screen-setup";
import { desktopScreenSetupStore } from "./screen-setup-file";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(contents?: string) {
  const dir = mkdtempSync(join(tmpdir(), "gloom-screen-setup-"));
  dirs.push(dir);
  const path = join(dir, "desktop-windows.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

describe("desktop window setup file", () => {
  test("a file it cannot read is kept as a copy before the next save replaces it", () => {
    const original = "{\"version\":1,\"windows\":[{\"id\":\"window:a\"";
    const path = file(original);
    const store = desktopScreenSetupStore(path);
    expect(store.load()).toEqual(emptyScreenSetup());
    store.save(emptyScreenSetup());
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(emptyScreenSetup());
  });

  test("no file yet leaves no copy", () => {
    const path = file();
    expect(desktopScreenSetupStore(path).load()).toEqual(emptyScreenSetup());
    expect(existsSync(`${path}.bak`)).toBe(false);
  });
});
