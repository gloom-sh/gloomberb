import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bun keeps the transpiled output of every source file of 50 KB or more in a
 * cache keyed by the file's contents only, so a run with NODE_ENV unset leaves
 * the development transform (`jsxDEV` calls) for a run with NODE_ENV=production,
 * whose React has no `jsxDEV`. The chart composer and the composite chart are
 * that large, and every chart pane on Home stopped working. Two processes
 * started through the CLI entry, sharing one cache, show it.
 */
test("a large JSX module cached by a development run still renders in a production run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gloom-jsx-dev-fallback-"));
  const cache = join(directory, "transpiler-cache");
  // Beside the sources, so the fixture's `react` resolves like the app's own.
  const fixture = join(import.meta.dir, `.jsx-dev-fallback-fixture-${process.pid}.tsx`);
  const driver = join(import.meta.dir, `.jsx-dev-fallback-driver-${process.pid}.ts`);
  try {
    await writeFile(fixture, [
      "export const element = <box><text>cached</text></box>;",
      // Past the size from which Bun caches the transpiled file.
      ...Array.from({ length: 700 }, (_, index) => `// ${String(index).padStart(4, "0")} ${"x".repeat(80)}`),
      "",
    ].join("\n"));
    // Starts the CLI entry as bin/gloom does, on a command that returns at
    // once, then loads the module the way a pane loads later.
    await writeFile(driver, `
      process.argv.splice(2, Infinity, "--version");
      await import(${JSON.stringify(join(import.meta.dir, "../cli/entry.ts"))});
      const { element } = await import(${JSON.stringify(fixture)});
      console.log("rendered:" + element.type);
    `);

    const run = async (nodeEnv: string | undefined) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache,
        GLOOMBERB_HOME: directory,
        GLOOMBERB_NO_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
      };
      delete env.NODE_ENV;
      if (nodeEnv) env.NODE_ENV = nodeEnv;
      const child = Bun.spawn([process.execPath, driver], { cwd: join(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        return { status, rendered: stdout.includes("rendered:box"), stderr: status === 0 ? "" : stderr };
      } finally {
        clearTimeout(timer);
      }
    };

    expect(await run(undefined)).toEqual({ status: 0, rendered: true, stderr: "" });
    // The development run left its output for the next one.
    expect((await readdir(cache)).length).toBeGreaterThan(0);
    expect(await run("production")).toEqual({ status: 0, rendered: true, stderr: "" });
  } finally {
    await rm(fixture, { force: true });
    await rm(driver, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
