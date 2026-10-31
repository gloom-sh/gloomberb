import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureConsole } from "../test-support/console";
import { dispatchCli } from "./index";
import { dispatchEarlyCommand } from "./early-command";

test("early version dispatch preserves command output, flags, help and exit status without creating a profile", async () => {
  const parent = join(homedir(), ".cache/gloom-smoke");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "cli-version-"));
  const profile = join(directory, "profile");
  const previousHome = process.env.GLOOMBERB_HOME;
  process.env.GLOOMBERB_HOME = profile;
  try {
    for (const args of [
      ["--version"], ["-v"], ["ＶＥＲＳＩＯＮ"], ["version", "ignored"],
      ["--json", "version"], ["version", "--csv"], ["version", "--ndjson"],
      ["version", "--quiet"], ["version", "--plain", "--width", "25"],
      ["version", "--help"], ["--help", "--version", "--json"],
      ["version", "--unsupported-option"], ["version", "--", "--unsupported-option"],
      ["version", "--ｅｘｐｌａｉｎ"], ["version", "--ｗｉｄｔｈ", "80"],
    ]) {
      const normal = await captureConsole(() => dispatchCli(args));
      const early = await captureConsole(() => dispatchEarlyCommand(args));
      expect({ ...early, exitCode: early.exitCode ?? 0 }, args.join(" ")).toEqual({ ...normal, exitCode: normal.exitCode ?? 0, result: true });
    }
    expect(await dispatchEarlyCommand(["catalog"])).toBe(false);
    expect(await dispatchEarlyCommand(["version", "--width", "bad"])).toBe(false);
    expect(await Bun.file(join(profile, "config.json")).exists()).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.GLOOMBERB_HOME;
    else process.env.GLOOMBERB_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
