import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// The functions Electrobun's updater builds its download names with (dist/api/bun/core/Updater.ts).
import { getAppFileName, getPlatformPrefix, getTarballFileName } from "../node_modules/electrobun/dist/api/shared/naming";
import { legacyDesktopFiles, writeLegacyDesktopFiles } from "./write-legacy-desktop-files";

// A release built as Gloom has to update installs built as Gloomberb, whose
// updater asks for files by that name and opens the Windows archive at a
// `Gloomberb` folder. These run both updaters' download and unpack steps
// against the files a release would publish.

let root = "";
let artifacts = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gloom-legacy-files-"));
  artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Packs `files` (paths under one top folder) as Electrobun does: system tar, then zstd. */
function updateArchive(path: string, files: Record<string, string>): void {
  const stage = mkdtempSync(join(root, "stage-"));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(stage, file, ".."), { recursive: true });
    writeFileSync(join(stage, file), contents);
  }
  const top = readdirSync(stage);
  const packed = Bun.spawnSync(["tar", "-cf", "out.tar", ...top], { cwd: stage });
  expect(packed.exitCode).toBe(0);
  writeFileSync(path, Bun.zstdCompressSync(readFileSync(join(stage, "out.tar"))));
  rmSync(stage, { recursive: true });
}

/** The files a stable release's desktop jobs leave in artifacts/, under the new name. */
function newRelease(channel = "stable"): void {
  updateArchive(join(artifacts, `${channel}-macos-arm64-Gloom.app.tar.zst`), {
    "Gloom.app/Contents/MacOS/launcher": "mac launcher",
    "Gloom.app/Contents/Resources/version.json": JSON.stringify({ version: "0.19.0", name: "Gloom" }),
  });
  updateArchive(join(artifacts, `${channel}-win-x64-Gloom.tar.zst`), {
    "Gloom/bin/launcher.exe": "windows launcher",
    "Gloom/Resources/version.json": JSON.stringify({ version: "0.19.0", name: "Gloom" }),
  });
  for (const file of [
    `${channel}-macos-arm64-Gloom.dmg`,
    `${channel}-macos-arm64-Gloom.app.zip`,
    `${channel}-macos-arm64-update.json`,
    `${channel}-win-x64-GloomSetup.exe`,
    `${channel}-win-x64-Gloom-Setup.zip`,
    `${channel}-win-x64-update.json`,
    "GloomSetup.exe",
    "gloomberb-darwin-arm64.gz",
  ]) writeFileSync(join(artifacts, file), file);
}

/**
 * What Electrobun's updater does with a release, for an app built under
 * `appName`: download `<prefix>-<tarball name>`, unpack it, and take the app
 * from it the way `applyUpdate` does on that platform. Resolves to the path it
 * would install, or throws where the updater would give up.
 */
async function update(appName: string, os: "macos" | "win", channel = "stable"): Promise<string> {
  // version.json's `name`: Electrobun builds both channels with its stable environment.
  const localName = getAppFileName(appName, "stable");
  const archive = join(artifacts, `${getPlatformPrefix(channel, os, os === "win" ? "x64" : "arm64")}-${getTarballFileName(localName, os)}`);
  if (!existsSync(archive)) throw new Error(`not in the release: ${archive.slice(artifacts.length + 1)}`);
  const extracted = mkdtempSync(join(root, "self-extraction-"));
  await new Bun.Archive(Bun.zstdDecompressSync(readFileSync(archive))).extract(extracted);
  if (os === "macos") {
    const app = readdirSync(extracted).find((entry) => entry.endsWith(".app"));
    if (!app) throw new Error("Failed to find app in tarball");
    return join(extracted, app);
  }
  const app = join(extracted, localName);
  if (!existsSync(app)) throw new Error(`Extracted app not found at: ${app}`);
  return app;
}

describe("a release built under the new name", () => {
  test("updates an install from before the rename on macOS and Windows, and a new one", async () => {
    newRelease();
    expect(await writeLegacyDesktopFiles(artifacts, join(root, "work"))).toEqual([
      "stable-macos-arm64-Gloomberb.app.tar.zst",
      "stable-macos-arm64-Gloomberb.dmg",
      "stable-win-x64-Gloomberb.tar.zst",
      "stable-win-x64-GloomberbSetup.exe",
    ]);

    for (const appName of ["Gloomberb", "Gloom"]) {
      const mac = await update(appName, "macos");
      expect(readFileSync(join(mac, "Contents", "MacOS", "launcher"), "utf8")).toBe("mac launcher");
      const windows = await update(appName, "win");
      expect(readFileSync(join(windows, "bin", "launcher.exe"), "utf8")).toBe("windows launcher");
      expect(JSON.parse(readFileSync(join(windows, "Resources", "version.json"), "utf8")).version).toBe("0.19.0");
    }
    // The working folder goes once the archive is packed.
    expect(readdirSync(join(root, "work"))).toEqual([]);
  });

  test("names nightly copies for the nightly updater and leaves other files alone", () => {
    expect(legacyDesktopFiles([
      "nightly-macos-arm64-Gloom.app.tar.zst",
      "nightly-win-x64-Gloom.tar.zst",
      "stable-linux-x64-Gloom.tar.zst",
      "stable-macos-arm64-Gloom.app.zip",
      "stable-macos-arm64-update.json",
      "stable-win-x64-Gloom-Setup.zip",
      "stable-macos-arm64-Gloomberb.dmg",
      "GloomSetup.exe",
    ])).toEqual([
      { source: "nightly-macos-arm64-Gloom.app.tar.zst", legacy: "nightly-macos-arm64-Gloomberb.app.tar.zst", renameTopFolder: false },
      { source: "nightly-win-x64-Gloom.tar.zst", legacy: "nightly-win-x64-Gloomberb.tar.zst", renameTopFolder: true },
      { source: "stable-linux-x64-Gloom.tar.zst", legacy: "stable-linux-x64-Gloomberb.tar.zst", renameTopFolder: false },
    ]);
  });

  test("the old Windows updater needs the archive packed again, not copied", async () => {
    newRelease();
    await expect(update("Gloomberb", "win")).rejects.toThrow("not in the release: stable-win-x64-Gloomberb.tar.zst");
    writeFileSync(join(artifacts, "stable-win-x64-Gloomberb.tar.zst"), readFileSync(join(artifacts, "stable-win-x64-Gloom.tar.zst")));
    await expect(update("Gloomberb", "win")).rejects.toThrow("Extracted app not found");
  });
});
