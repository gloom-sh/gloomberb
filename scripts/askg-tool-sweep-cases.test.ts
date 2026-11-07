import { expect, test } from "bun:test";

// The latency sweep (scripts/askg-tool-sweep.ts) only covers the tools it has
// cases for: a function Ask Gloom gains is swept from the day it ships. Its
// check loads every plugin, so it runs in its own process, not this one.
test("every tool Ask Gloom calls in the app has a heavy case in the latency sweep, and every case names one", () => {
  const check = Bun.spawnSync([process.execPath, "scripts/askg-tool-sweep.ts", "--check"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    timeout: 60_000,
  });
  const stdout = check.stdout.toString();
  // What failed, when it fails: the tools without a case and the cases naming none, or the error.
  expect({ exitCode: check.exitCode, last: stdout.trim().split("\n").at(-1) }, `${stdout}${check.stderr.toString()}`)
    .toEqual({ exitCode: 0, last: expect.stringMatching(/^\d+ tools, \d+ cases$/) });
}, 70_000);
