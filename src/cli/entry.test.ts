import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged UI launches restore once before loading the TUI catalog; headless commands do not restore", async () => {
  const root = join(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), "gloom-cli-entry-"));
  const preload = join(directory, "preload.ts");
  const modulePath = (path: string) => JSON.stringify(join(root, "src", path));
  try {
    // Isolate module mocks from the rest of the suite, while exercising the shipped bin entry.
    await Bun.write(preload, `
      import { mock } from "bun:test";
      const calls = [];
      let restored = false;
      mock.module(${modulePath("cli/restore-plugins.ts")}, () => ({ restoreExtractedPlugins: async () => {
        calls.push("restore"); restored = true;
      }}));
      mock.module(${modulePath("plugins/loader.ts")}, () => ({ loadExternalPlugins: async (target = "cli") => {
        calls.push("catalog:" + target);
        return restored ? [{ plugin: { id: "tv" }, path: "tv" }] : [];
      }}));
      mock.module(${modulePath("cli/index.ts")}, () => ({ dispatchCli: async (args) => {
        calls.push("dispatch:" + args[0]);
        return args[0] === "handoff" ? { kind: "launch-ui", request: { source: "handoff" } } : { kind: "handled" };
      }}));
      mock.module(${modulePath("renderers/opentui/start.tsx")}, () => ({ startOpenTuiApp: async (options) => {
        calls.push({ launch: options.externalPlugins.map((entry) => entry.plugin.id), args: options.cliArgs, request: options.cliLaunchRequest });
      }}));
      process.on("beforeExit", () => console.log(JSON.stringify(calls)));
    `);
    for (const args of [[], ["ui"], ["launch-ui", "TV"], ["handoff"], ["help"]]) {
      const child = Bun.spawn([process.execPath, "--preload", preload, join(root, "bin/gloomberb"), ...args], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      const calls = JSON.parse(stdout.trim());
      if (args[0] === "help") {
        expect(calls).toEqual(["catalog:cli", "dispatch:help"]);
      } else {
        expect(calls).toEqual([
          ...(args[0] === "handoff" ? ["catalog:cli", "dispatch:handoff"] : []),
          "restore", "catalog:tui",
          { launch: ["tv"], args: args[0] === "launch-ui" ? ["TV"] : [], request: args[0] === "handoff" ? { source: "handoff" } : null },
        ]);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
