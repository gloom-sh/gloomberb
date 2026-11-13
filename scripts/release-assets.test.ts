import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The files v0.20.13 was first published with: its Apple Silicon terminal
// build never got a runner, and the release went out without it.
const V0_20_13_AS_PUBLISHED = [
  "GloomSetup.exe",
  "gloomberb-darwin-x64.gz",
  "gloomberb-linux-arm64-musl.gz",
  "gloomberb-linux-arm64.gz",
  "gloomberb-linux-x64-musl.gz",
  "gloomberb-linux-x64.gz",
  "gloomberb-windows-x64.exe.gz",
  "stable-macos-arm64-Gloom.app.tar.zst",
  "stable-macos-arm64-Gloom.app.zip",
  "stable-macos-arm64-Gloom.dmg",
  "stable-macos-arm64-Gloomberb.app.tar.zst",
  "stable-macos-arm64-Gloomberb.app.zip",
  "stable-macos-arm64-Gloomberb.dmg",
  "stable-macos-arm64-update.json",
  "stable-win-x64-Gloom.tar.zst",
  "stable-win-x64-GloomSetup.exe",
  "stable-win-x64-Gloomberb.tar.zst",
  "stable-win-x64-GloomberbSetup.exe",
  "stable-win-x64-update.json",
];

let dist = "";

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "gloom-release-assets-"));
});

afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
});

function check() {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "release-assets.ts"), "check", dist], {
    env: { ...process.env, GITHUB_RUN_ID: "" },
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

test("holds back a release a matrix build uploaded nothing for, and passes it once the rerun built it", () => {
  for (const name of V0_20_13_AS_PUBLISHED) writeFileSync(join(dist, name), name);
  const held = check();
  expect(held.exitCode).toBe(1);
  expect(held.stderr).toContain("1 of 19 release files were not built: gloomberb-darwin-arm64.gz\n");

  writeFileSync(join(dist, "gloomberb-darwin-arm64.gz"), "built on the rerun");
  expect(check()).toEqual({ exitCode: 0, stderr: "" });
});
