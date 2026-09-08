import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const caskScript = join(import.meta.dir, "write-homebrew-cask.ts");

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gloomberb-cask-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function renderCask(): Promise<string> {
  const output = join(workDir, "gloomberb.rb");
  const proc = Bun.spawn([
    "bun",
    "run",
    caskScript,
    "--version",
    "1.2.3",
    "--sha256",
    "a".repeat(64),
    "--output",
    output,
  ], { stdout: "pipe", stderr: "pipe" });

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);

  return readFileSync(output, "utf8");
}

describe("write-homebrew-cask", () => {
  // The cask points at an Apple Silicon app bundle, so Homebrew has to refuse
  // Intel Macs instead of installing something that cannot launch.
  // https://github.com/gloom-sh/gloomberb/issues/539
  test("declares the cask as Apple Silicon only", async () => {
    expect(await renderCask()).toContain("depends_on arch: :arm64");
  });

  test("keeps the app bundle and terminal command wiring", async () => {
    const cask = await renderCask();

    expect(cask).toContain(
      'url "https://github.com/gloom-sh/gloomberb/releases/download/v#{version}/stable-macos-arm64-Gloomberb.app.zip"',
    );
    expect(cask).toContain('app "Gloomberb.app"');
    expect(cask).toContain(
      'binary "#{appdir}/Gloomberb.app/Contents/Resources/gloomberb", target: "gloomberb"',
    );
  });
});
