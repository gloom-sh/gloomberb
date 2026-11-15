import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { attestedInRun, type VerifiedAttestation } from "./check-built-files";

const REPO = "gloom-sh/gloomberb";
const RUN_ID = "43662124894";
const RUN = `https://github.com/${REPO}/actions/runs/${RUN_ID}`;
// Last night's run, made by the same workflow, with a terminal binary of the same name.
const OTHER_RUN = `https://github.com/${REPO}/actions/runs/43591497564`;

/** The part of a `gh attestation verify --format json` entry the check reads, as gh prints it. */
function attestation(runInvocationURI: string, subjects: Array<[name: string, sha256: string]>): VerifiedAttestation {
  return {
    verificationResult: {
      signature: { certificate: { runInvocationURI } },
      statement: { subject: subjects.map(([name, sha256]) => ({ name, digest: { sha256 } })) },
    },
  };
}

test("passes a file only when an attestation of this run, in any attempt, names it with its digest", () => {
  const sha = "a".repeat(64);
  const name = "gloomberb-linux-x64.gz";
  const passes = (verified: VerifiedAttestation) => attestedInRun([verified], RUN, name, sha);

  expect(passes(attestation(`${RUN}/attempts/1`, [[name, sha]]))).toBe(true);
  // `gh run rerun --failed` builds a missing platform again as attempt 2.
  expect(passes(attestation(`${RUN}/attempts/2`, [[name, sha]]))).toBe(true);
  expect(passes(attestation(`${OTHER_RUN}/attempts/1`, [[name, sha]]))).toBe(false);
  expect(passes(attestation(`${RUN}5/attempts/1`, [[name, sha]]))).toBe(false);
  // Another file this run built, under this one's name.
  expect(passes(attestation(`${RUN}/attempts/1`, [["gloomberb-linux-arm64.gz", sha]]))).toBe(false);
  expect(passes(attestation(`${RUN}/attempts/1`, [[name, "b".repeat(64)]]))).toBe(false);
  expect(attestedInRun([attestation(`${OTHER_RUN}/attempts/1`, [[name, sha]]), attestation(`${RUN}/attempts/1`, [[name, sha]])], RUN, name, sha)).toBe(true);
});

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gloom-check-built-files-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(contents: string): string {
  return new Bun.CryptoHasher("sha256").update(contents).digest("hex");
}

/**
 * A `gh` that answers `attestation verify` for this repository and the build
 * workflow only, with the verified attestations `answers` holds for the
 * file's name, or no attestations found.
 */
function fakeGh(answers: Record<string, VerifiedAttestation[]>): string {
  const bin = join(root, "bin");
  const answerDir = join(root, "answers");
  mkdirSync(bin);
  mkdirSync(answerDir);
  for (const [name, verified] of Object.entries(answers)) writeFileSync(join(answerDir, `${name}.json`), JSON.stringify(verified));
  writeFileSync(join(bin, "gh"), `#!/bin/sh
expected="attestation verify $3 --repo ${REPO} --signer-workflow ${REPO}/.github/workflows/build-release-assets.yml --deny-self-hosted-runners --format json"
[ "$*" = "$expected" ] || { echo "unexpected arguments: $*" >&2; exit 2; }
answer="${answerDir}/$(basename "$3").json"
[ -f "$answer" ] || { echo "Error: no attestations found" >&2; exit 1; }
cat "$answer"
`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function check(dist: string, bin: string) {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "check-built-files.ts"), dist], {
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: RUN_ID, GITHUB_SERVER_URL: "https://github.com" },
    timeout: 30_000,
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

test("fails by name every entry the build jobs of this run did not attest, and passes once only theirs are left", () => {
  const dist = join(root, "dist");
  mkdirSync(dist);
  const built = { "gloomberb-linux-x64.gz": "linux", "stable-win-x64-GloomSetup.exe": "installer", "GloomSetup.exe": "installer" };
  for (const [name, contents] of Object.entries(built)) writeFileSync(join(dist, name), contents);
  const bin = fakeGh({
    // One attestation covers a job's files; the installer is attested under both its names.
    ...Object.fromEntries(Object.keys(built).map((name) => [name, [
      attestation(`${RUN}/attempts/1`, [["GloomSetup.exe", sha256("installer")], ["stable-win-x64-GloomSetup.exe", sha256("installer")]]),
      attestation(`${RUN}/attempts/2`, [["gloomberb-linux-x64.gz", sha256("linux")]]),
    ]])),
    "gloomberb-darwin-arm64.gz": [attestation(`${OTHER_RUN}/attempts/1`, [["gloomberb-darwin-arm64.gz", sha256("last night")]])],
  });
  writeFileSync(join(dist, "gloomberb-darwin-arm64.gz"), "last night");
  writeFileSync(join(dist, "gloomberb-linux-arm64.gz"), "never attested");
  symlinkSync(join(dist, "gloomberb-linux-x64.gz"), join(dist, "gloomberb-linux-x64-musl.gz"));
  mkdirSync(join(dist, "windows-gui-verification"));
  writeFileSync(join(dist, "windows-gui-verification", "windows-gui-main.png"), "screenshot");

  const failed = check(dist, bin);
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toContain(`gloomberb-darwin-arm64.gz: no attestation from this run names it with sha256 ${sha256("last night")}\n`);
  expect(failed.stderr).toContain("gloomberb-linux-arm64.gz: Error: no attestations found\n");
  expect(failed.stderr).toContain("gloomberb-linux-x64-musl.gz: not a file\n");
  expect(failed.stderr).toContain("windows-gui-verification: not a file\n");
  for (const name of Object.keys(built)) expect(failed.stderr).not.toContain(`  ${name}:`);

  for (const name of ["gloomberb-darwin-arm64.gz", "gloomberb-linux-arm64.gz", "gloomberb-linux-x64-musl.gz", "windows-gui-verification"]) {
    rmSync(join(dist, name), { recursive: true });
  }
  expect(check(dist, bin)).toEqual({ exitCode: 0, stderr: "" });

  rmSync(dist, { recursive: true });
  mkdirSync(dist);
  expect(check(dist, bin).stderr).toContain("holds no files");
});
