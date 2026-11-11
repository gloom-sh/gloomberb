import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { emptyScreenSetup } from "../../../desktop/screen-setup";
import { desktopScreenSetupStore } from "./screen-setup-file";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a window setup it can neither read nor copy is left in place, and the log does not claim a copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "gloom-screen-setup-"));
  dirs.push(dir);
  const path = join(dir, "desktop-windows.json");
  const original = "{\"version\":1,\"windows\":[{\"id\":\"window:a\"";
  writeFileSync(path, original);
  const copy = spyOn(fs, "copyFileSync").mockImplementation(() => {
    throw Object.assign(new Error("EACCES: permission denied, copyfile"), { code: "EACCES" });
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const store = desktopScreenSetupStore(path);
    expect(store.load()).toEqual(emptyScreenSetup());
    store.save(emptyScreenSetup());
    expect(copy).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(logged.mock.calls).toEqual([[
      "[desktop] the window setup could not be read or copied; it is left as it is, and window changes are not saved until a later launch can keep a copy",
    ]]);
  } finally {
    copy.mockRestore();
    logged.mockRestore();
  }
});
