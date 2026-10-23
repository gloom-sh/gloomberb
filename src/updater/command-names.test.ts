import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { linkDesktopCommands, linkStandaloneCommand } from "./command-names";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gloom-command-names-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function linkOf(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

// A binary installed before the rename replaces itself on update and never
// gets a second name from an installer; the new build adds it.
describe("standalone binary", () => {
  test("adds gloom beside a gloomberb binary, and gloomberb beside a gloom one", () => {
    const old = folder("old");
    writeFileSync(join(old, "gloomberb"), "binary");
    expect(linkStandaloneCommand(join(old, "gloomberb"))).toBe(join(old, "gloom"));
    expect(linkOf(join(old, "gloom"))).toBe("gloomberb");

    const fresh = folder("fresh");
    writeFileSync(join(fresh, "gloom"), "binary");
    expect(linkStandaloneCommand(join(fresh, "gloom"))).toBe(join(fresh, "gloomberb"));
    expect(linkOf(join(fresh, "gloomberb"))).toBe("gloom");
  });

  test("leaves an existing command, another name and an unwritable folder alone", () => {
    const bin = folder("bin");
    writeFileSync(join(bin, "gloomberb"), "binary");
    writeFileSync(join(bin, "gloom"), "someone else's gloom");
    expect(linkStandaloneCommand(join(bin, "gloomberb"))).toBeNull();
    expect(readFileSync(join(bin, "gloom"), "utf8")).toBe("someone else's gloom");

    writeFileSync(join(bin, "gloomberb-linux-x64"), "binary");
    expect(linkStandaloneCommand(join(bin, "gloomberb-linux-x64"))).toBeNull();

    const locked = folder("locked");
    writeFileSync(join(locked, "gloomberb"), "binary");
    chmodSync(locked, 0o555);
    try {
      const added = linkStandaloneCommand(join(locked, "gloomberb"));
      // Root writes anyway; anyone else is refused, without an error.
      if (process.getuid?.() !== 0) expect(added).toBeNull();
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("desktop app on a Mac", () => {
  function bundle(commands: string[]): string {
    const resources = folder("Applications", "Gloomberb.app", "Contents", "Resources");
    for (const command of commands) writeFileSync(join(resources, command), "#!/bin/sh\n");
    return resources;
  }

  test("adds gloom beside each gloomberb link into the app, written as Homebrew writes it", () => {
    const resources = bundle(["gloom", "gloomberb"]);
    const home = folder("home");
    const local = folder("home", ".local", "bin");
    const brew = folder("brew", "bin");
    symlinkSync(join(resources, "gloomberb"), join(local, "gloomberb"));
    symlinkSync(join(resources, "gloomberb"), join(brew, "gloomberb"));

    const added = linkDesktopCommands({ platform: "darwin", homeDir: home, pathEnv: `${brew}:/usr/bin`, homebrewBins: [] });

    expect(added.sort()).toEqual([join(brew, "gloom"), join(local, "gloom")].sort());
    expect(linkOf(join(local, "gloom"))).toBe(join(resources, "gloom"));
    expect(linkOf(join(brew, "gloom"))).toBe(join(resources, "gloom"));
    // A second launch finds them there.
    expect(linkDesktopCommands({ platform: "darwin", homeDir: home, pathEnv: brew, homebrewBins: [] })).toEqual([]);
  });

  test("adds nothing for an app without gloom, a gloomberb that is not a link into an app, or an existing gloom", () => {
    const resources = bundle(["gloomberb"]);
    const home = folder("home");
    const local = folder("home", ".local", "bin");
    symlinkSync(join(resources, "gloomberb"), join(local, "gloomberb"));
    expect(linkDesktopCommands({ platform: "darwin", homeDir: home, pathEnv: "", homebrewBins: [] })).toEqual([]);

    writeFileSync(join(resources, "gloom"), "#!/bin/sh\n");
    const standalone = folder("standalone");
    writeFileSync(join(standalone, "gloomberb"), "binary");
    const other = folder("other");
    symlinkSync(join(resources, "gloomberb"), join(other, "gloomberb"));
    writeFileSync(join(other, "gloom"), "another program");

    expect(linkDesktopCommands({ platform: "darwin", homeDir: home, pathEnv: `${standalone}:${other}`, homebrewBins: [] }))
      .toEqual([join(local, "gloom")]);
    expect(existsSync(join(standalone, "gloom"))).toBe(false);
    expect(readFileSync(join(other, "gloom"), "utf8")).toBe("another program");
  });
});

describe("desktop app on Windows", () => {
  test("copies the app's gloomberb.cmd to gloom.cmd in its PATH folder only", () => {
    const shim = '@echo off\r\n"%APP_DIR%\\bin\\bun.exe" "%APP_DIR%\\Resources\\gloomberb-tui\\tui-entry.js" %*\r\n';
    const localAppData = folder("AppData", "Local");
    const installed = folder("AppData", "Local", "Programs", "Gloomberb", "bin");
    writeFileSync(join(installed, "gloomberb.cmd"), shim);
    const elsewhere = folder("custom", "bin");
    writeFileSync(join(elsewhere, "gloomberb.cmd"), shim);
    const unrelated = folder("unrelated");
    writeFileSync(join(unrelated, "gloomberb.cmd"), "@echo another program\r\n");

    const added = linkDesktopCommands({
      platform: "win32",
      homeDir: "",
      pathEnv: [elsewhere, unrelated, installed].join(";"),
      localAppData,
    });

    expect(added.sort()).toEqual([join(elsewhere, "gloom.cmd"), join(installed, "gloom.cmd")].sort());
    expect(readFileSync(join(installed, "gloom.cmd"), "utf8")).toBe(shim);
    expect(existsSync(join(unrelated, "gloom.cmd"))).toBe(false);
  });
});
