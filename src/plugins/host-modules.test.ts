import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";

import { hostExportNames } from "./bundle";
import { PLUGIN_HOST_GLOBAL, SHARED_SPECIFIERS } from "./host-modules";

describe("plugin host modules", () => {
  test("discovers export names through host-local imports", async () => {
    const names = await hostExportNames("gloomberb/ui");

    expect(names).toContain("Box");
    expect(names).toContain("Text");
  });

  test("discovers and bundles shared modules from a Bun compiled executable", () => {
    const entry = join(import.meta.dir, `.compiled-host-module-entry-${process.pid}.ts`);
    const outfile = join(import.meta.dir, `.compiled-host-module-entry-${process.pid}.exe`);
    writeFileSync(entry, `
      import { mkdtempSync, rmSync, writeFileSync } from "fs";
      import { tmpdir } from "os";
      import { join } from "path";
      import { bundleExternalPlugin, hostExportNames } from "./bundle";
      import { importAllPluginHostModules } from "./host-modules";

      const pluginDir = mkdtempSync(join(tmpdir(), "gloom-compiled-plugin-"));
      try {
        writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "compiled-plugin", main: "index.tsx" }));
        writeFileSync(join(pluginDir, "index.tsx"), [
          "import { Box } from \\\"gloomberb/ui\\\";",
          "export default { id: \\\"compiled-plugin\\\", name: \\\"Compiled plugin\\\", version: \\\"1.0.0\\\", Box };",
          "",
        ].join("\\n"));
        const hostModules = await importAllPluginHostModules();
        const names = await hostExportNames("gloomberb/ui");
        const result = await bundleExternalPlugin(pluginDir, join(pluginDir, "out"));
        const code = await Bun.file(result.outputPath).text();
        console.log(JSON.stringify({
          importMetaDir: import.meta.dir,
          hostModuleCount: Object.keys(hostModules).length,
          names,
          shared: result.shared,
          hasHostRegistry: code.includes(${JSON.stringify(PLUGIN_HOST_GLOBAL)}),
        }));
      } finally {
        rmSync(pluginDir, { recursive: true, force: true });
      }
    `);

    try {
      const build = Bun.spawnSync(
        [process.execPath, "build", "--compile", entry, "--outfile", outfile],
        { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
      );
      if (build.exitCode !== 0) {
        throw new Error(`compiled test fixture failed to build:\n${build.stdout.toString()}\n${build.stderr.toString()}`);
      }

      const run = Bun.spawnSync([outfile], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) {
        throw new Error(`compiled test fixture failed to run:\n${run.stdout.toString()}\n${run.stderr.toString()}`);
      }
      const result = JSON.parse(run.stdout.toString()) as {
        importMetaDir: string;
        hostModuleCount: number;
        names: string[];
        shared: string[];
        hasHostRegistry: boolean;
      };

      // Bun's embedded filesystem is `B:/~BUN/root` on Windows and `/$bunfs/root`
      // elsewhere; either one proves the code ran from inside the executable.
      expect(result.importMetaDir.replaceAll("\\", "/")).toMatch(/\/(~BUN|\$bunfs)\/root$/i);
      expect(result.hostModuleCount).toBe(SHARED_SPECIFIERS.length);
      expect(result.names).toContain("Box");
      expect(result.shared).toEqual(["gloomberb/ui"]);
      expect(result.hasHostRegistry).toBe(true);
    } finally {
      rmSync(entry, { force: true });
      rmSync(outfile, { force: true });
    }
  });
});
