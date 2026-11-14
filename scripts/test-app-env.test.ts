import { expect, test } from "bun:test";
import { join } from "path";
import { runInNewContext } from "vm";
import { testAppEnv, TEST_BROWSER_PRIVACY_SCRIPT } from "./test-app-env";

const optOut = { GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" };

test("test app environments force opt-outs after inherited values and overrides without changing either", () => {
  const original = {
    GLOOMBERB_NO_TELEMETRY: process.env.GLOOMBERB_NO_TELEMETRY,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  };
  process.env.GLOOMBERB_NO_TELEMETRY = "0";
  process.env.DO_NOT_TRACK = "false";
  try {
    const overrides = { GLOOMBERB_NO_TELEMETRY: "false", DO_NOT_TRACK: "0", GLOOM_TEST_MARKER: "preserved" };
    expect(testAppEnv()).toMatchObject(optOut);
    expect(testAppEnv(overrides)).toMatchObject({
      ...optOut,
      GLOOM_TEST_MARKER: "preserved",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    });
    expect(overrides).toEqual({ GLOOMBERB_NO_TELEMETRY: "false", DO_NOT_TRACK: "0", GLOOM_TEST_MARKER: "preserved" });
    expect(process.env.GLOOMBERB_NO_TELEMETRY).toBe("0");
    expect(process.env.DO_NOT_TRACK).toBe("false");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("child apps receive both opt-outs and unrelated environment overrides", () => {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `console.log(JSON.stringify({
    GLOOMBERB_NO_TELEMETRY: process.env.GLOOMBERB_NO_TELEMETRY,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    GLOOM_TEST_MARKER: process.env.GLOOM_TEST_MARKER,
  }))`], {
    env: testAppEnv({ GLOOMBERB_NO_TELEMETRY: "0", DO_NOT_TRACK: "0", GLOOM_TEST_MARKER: "child" }),
    timeout: 10_000,
  });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ ...optOut, GLOOM_TEST_MARKER: "child" });
});

test.each(["inherited", "absent"])("browser privacy init repeats with %s DNT and lets the Share fixture initialize", (property) => {
  const prototype = property === "inherited" ? { get doNotTrack() { return "0"; } } : null;
  const navigator = Object.assign(Object.create(prototype), { language: "en-US" });
  const window = {} as Record<string, number>;
  let observing = false;
  const context = {
    navigator,
    window,
    document: {},
    MutationObserver: class {
      observe() { observing = true; }
    },
  };
  runInNewContext(TEST_BROWSER_PRIVACY_SCRIPT, context);
  expect(navigator).toMatchObject({ doNotTrack: "1", language: "en-US" });
  runInNewContext(TEST_BROWSER_PRIVACY_SCRIPT, context);
  runInNewContext(`
    Object.defineProperty(navigator, "doNotTrack", { value: "1" });
    window.__shareDialogCount = 0;
    window.__linkCopiedToasts = 0;
    new MutationObserver(() => {}).observe(document, { childList: true, subtree: true });
  `, context);
  expect(navigator).toMatchObject({ doNotTrack: "1", language: "en-US" });
  expect(window).toEqual({ __shareDialogCount: 0, __linkCopiedToasts: 0 });
  expect(observing).toBe(true);
});

test("browser privacy init accepts a fixture's non-configurable opt-out", () => {
  const navigator = Object.defineProperty({ language: "en-US" }, "doNotTrack", { value: "1" });
  runInNewContext(TEST_BROWSER_PRIVACY_SCRIPT, { navigator });
  runInNewContext(TEST_BROWSER_PRIVACY_SCRIPT, { navigator });
  expect(navigator).toMatchObject({ doNotTrack: "1", language: "en-US" });
});

type Environment = Record<string, string>;
type Workflow = {
  env: Environment;
  jobs: Record<string, { env?: Environment; steps?: Array<{ env?: Environment }> }>;
};

test.each([
  "build-release-assets",
  "desktop-shell-check",
  "load-registry-plugins",
  "pane-chrome",
  "performance",
  "ui-benchmark",
  "ui-tokens",
  "verify-desktop-homebrew",
  "verify-windows",
  "verify",
  "windows-desktop-check",
])("%s opts out app runs at workflow scope without job or step overrides", async (name) => {
  const path = join(import.meta.dir, "../.github/workflows", `${name}.yml`);
  const workflow = Bun.YAML.parse(await Bun.file(path).text()) as Workflow;
  expect(workflow.env).toMatchObject(optOut);
  for (const job of Object.values(workflow.jobs)) {
    expect({ ...workflow.env, ...job.env }).toMatchObject(optOut);
    for (const step of job.steps ?? []) {
      expect({ ...workflow.env, ...job.env, ...step.env }).toMatchObject(optOut);
    }
  }
});
