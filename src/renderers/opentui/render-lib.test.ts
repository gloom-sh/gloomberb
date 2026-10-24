import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadRenderLibWith, RenderLibUnavailableError, type RenderLibLoadOptions } from "./render-lib";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LIBRARY = "binary contents of the render library";

/**
 * A standalone binary's folders: the library as it sits inside the binary,
 * Bun's temp folder and the native cache folder. `load` fails the way
 * @opentui/core does for the default library and loads any path it is given.
 */
function setup(defaultLoad: string | null = "/$bunfs/root/libopentui-new.so: cannot open shared object file") {
  const root = mkdtempSync(join(tmpdir(), "gloom-render-lib-"));
  scratch.push(root);
  const embeddedPath = join(root, "bunfs", "libopentui-new.so");
  mkdirSync(join(root, "bunfs"));
  writeFileSync(embeddedPath, LIBRARY);
  const tempDir = join(root, "tmp");
  mkdirSync(tempDir);
  const loaded: Array<string | undefined> = [];
  const options: RenderLibLoadOptions = {
    load(path) {
      if (!path && defaultLoad) throw new Error(`Failed to initialize OpenTUI render library: ${defaultLoad}`);
      loaded.push(path);
    },
    embeddedPath,
    tempDir,
    cacheDir: join(root, "native-cache"),
    readMaps: () => null,
    startedAtMs: Date.now() - 1_000,
  };
  return { root, options, loaded };
}

describe("loadRenderLibWith", () => {
  test("a temp folder that cannot take the library: one copy in the cache, reused until an upgrade replaces it", () => {
    const { options, loaded } = setup();
    const cached = join(options.cacheDir, "libopentui-new.so");

    loadRenderLibWith(options);
    expect(loaded).toEqual([cached]);
    expect(readFileSync(cached, "utf8")).toBe(LIBRARY);

    // Later launches load the copy as it is.
    const written = statSync(cached).ino;
    loadRenderLibWith(options);
    expect(statSync(cached).ino).toBe(written);

    // A copy cut short is written again.
    writeFileSync(cached, "binary");
    loadRenderLibWith(options);
    expect(readFileSync(cached, "utf8")).toBe(LIBRARY);

    // An upgrade's library has another name; the old copy goes.
    const upgraded = join(options.embeddedPath!, "..", "libopentui-next.so");
    writeFileSync(upgraded, `${LIBRARY}, next version`);
    loadRenderLibWith({ ...options, embeddedPath: upgraded });
    expect(readdirSync(options.cacheDir)).toEqual(["libopentui-next.so"]);
  });

  test("a noexec or full temp folder: the copies Bun wrote this launch are removed, nothing else", () => {
    const { options, loaded } = setup(`Failed to open library "/tmp/.fff9-00000001.so": failed to map segment from shared object`);
    const copy = (name: string, contents: string) => {
      const path = join(options.tempDir, name);
      writeFileSync(path, contents);
      return path;
    };
    const thisLaunch = [
      copy(".fff965fcfbf3f7ef-00000000.so", LIBRARY),
      copy(".fff965fcfbfbfff9-00000001.so", LIBRARY),
      // Cut off by a full folder.
      copy(".fff965fcfbfbfff8-00000002.so", LIBRARY.slice(0, 6)),
    ];
    const earlierLaunch = copy(".fff965fcfbfbfffa-00000000.so", LIBRARY);
    utimesSync(earlierLaunch, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const anotherLibrary = copy(".fff965fcfbfbfffb-00000000.so", `${LIBRARY} and then some`);
    const notBuns = copy("libopentui.so", LIBRARY);

    loadRenderLibWith(options);
    expect(loaded).toEqual([join(options.cacheDir, "libopentui-new.so")]);
    expect(thisLaunch.filter(existsSync)).toEqual([]);
    expect([earlierLaunch, anotherLibrary, notBuns].filter(existsSync)).toHaveLength(3);
  });

  test("loaded from the temp folder: the copy this process mapped is removed", () => {
    const { options, loaded } = setup(null);
    const mapped = join(options.tempDir, ".fff965fedfbbf3fe-00000000.so");
    const unrelated = join(options.tempDir, "libother.so");
    writeFileSync(mapped, LIBRARY);
    writeFileSync(unrelated, LIBRARY);
    const maps = [
      `7f0a1c000000-7f0a1c200000 r--p 00000000 00:2a 1234 ${mapped}`,
      `7f0a1c200000-7f0a1c600000 r-xp 00200000 00:2a 1234 ${mapped}`,
      `7f0a1d000000-7f0a1d100000 r-xp 00000000 00:2a 1235 ${unrelated}`,
      "7f0a1e000000-7f0a1e021000 rw-p 00000000 00:00 0 [heap]",
    ].join("\n");

    loadRenderLibWith({ ...options, readMaps: () => maps });
    expect(loaded).toEqual([undefined]);
    expect(existsSync(mapped)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(options.cacheDir)).toBe(false);
  });

  test("both folders failing ends in one line naming the temp folder; a library that loads nowhere fails later as before", () => {
    const { root, options } = setup();
    // A cache folder that cannot be created, even as root.
    writeFileSync(join(root, "file"), "");
    const blocked = { ...options, cacheDir: join(root, "file", "native-cache") };
    expect(() => loadRenderLibWith(blocked)).toThrow(RenderLibUnavailableError);
    expect(() => loadRenderLibWith(blocked)).toThrow(`the temp folder ${options.tempDir} nor`);

    const missingSymbol = setup("Error relocating /tmp/.fff9-00000000.so: getcontext: symbol not found");
    expect(() => loadRenderLibWith({ ...missingSymbol.options, cacheDir: blocked.cacheDir })).not.toThrow();

    // Run from a package or a checkout: nothing to copy, nothing written.
    const fromPackage = setup();
    expect(() => loadRenderLibWith({ ...fromPackage.options, embeddedPath: null })).not.toThrow();
    expect(existsSync(fromPackage.options.cacheDir)).toBe(false);
  });
});
