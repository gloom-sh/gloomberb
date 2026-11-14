import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, "../.github/workflows/migrate-environment-secrets.yml"), "utf8"),
) as { jobs: { seal: { steps: { name: string; run?: string }[] } } };
const programs = workflow.jobs.seal.steps.flatMap((step) =>
  step.run ? [step.run.split("<<'PY'\n")[1]!.replace(/\nPY\s*$/, "")] : [],
);

for (const fixture of [
  "test_bad_values_are_rejected_before_any_encryption",
  "test_bad_destinations_and_public_keys_are_rejected_before_any_encryption",
  "test_image_and_library_failures_never_load_unverified_crypto",
  "test_non_main_or_non_manual_context_creates_no_artifact",
  "test_runtime_failure_never_prints_values_or_creates_an_artifact",
  "test_encryption_failure_leaves_no_partial_artifact",
]) {
  test(fixture.replaceAll("_", " "), () => runFixture(fixture));
}

test.skipIf(process.platform !== "linux")("sealed fixtures round trip without changing UTF-8 bytes", () => {
  runFixture("test_round_trip_ciphertext_only_artifact_and_exclusive_output");
});

function runFixture(fixture: string): void {
  const result = Bun.spawnSync([
    "/usr/bin/python3", "-I", resolve(import.meta.dir, "environment-secrets.test.py"), fixture,
  ], {
    stdin: Buffer.from(JSON.stringify(programs)),
    env: { PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? tmpdir() },
    timeout: 20_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}
