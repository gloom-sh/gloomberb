import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";

import { PLUGIN_HOST_RESOLVER_IMPORTERS } from "./host-modules";

/**
 * The resolver is what lets the compiled terminal binary and the packaged
 * desktop app load an external plugin at all. Neither has a Gloomberb
 * package on disk for host-link.ts to symlink, so without it every plugin's
 * `gloomberb/*` import failed and the panes that moved out of this
 * repository disappeared on upgrade.
 *
 * It cannot be exercised in this process: registering it rewires how `react`
 * resolves for every test file that follows. So the test compiles a small
 * host into an executable, which has no package root, and loads a plugin
 * from a temporary directory through the real loader.
 */
describe("plugin host resolver", () => {
  test("covers every runtime export of the package that a plugin can import", async () => {
    // A new entry in package.json `exports` that the resolver does not know
    // about resolves from a source install and fails from a packaged one.
    // Only the empty package root and the test harness are deliberately left out.
    const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json() as { exports: Record<string, string> };
    const exported = Object.keys(pkg.exports)
      .filter((key) => key !== "." && key !== "./package.json" && key !== "./test-support")
      .map((key) => `gloomberb/${key.slice(2)}`)
      .sort();

    const served = Object.keys(PLUGIN_HOST_RESOLVER_IMPORTERS).filter((specifier) => specifier.startsWith("gloomberb/")).sort();

    expect(served).toEqual(exported);
  });

  test("loads an external plugin from a Bun compiled executable with no package root", () => {
    const entry = join(import.meta.dir, `.compiled-host-resolver-entry-${process.pid}.ts`);
    const outfile = join(import.meta.dir, `.compiled-host-resolver-entry-${process.pid}.exe`);
    writeFileSync(entry, `
      import { findHostPackageRoot } from "./host-link";
      import { isPluginHostResolverInstalled } from "./host-resolver";
      import { smokePluginHostLoad } from "./host-smoke";

      const hostRoot = findHostPackageRoot();
      await smokePluginHostLoad();
      console.log(JSON.stringify({
        importMetaDir: import.meta.dir,
        hostRoot,
        resolverInstalled: isPluginHostResolverInstalled(),
      }));
    `);

    try {
      // The same flags as scripts/build.ts. `--production` is what makes the
      // host's React a production build, whose jsx-dev-runtime has no
      // `jsxDEV`; without `--compile-autoload-package-json` the executable
      // cannot resolve a plugin dependency that publishes an `exports` map.
      const build = Bun.spawnSync(
        [
          process.execPath, "build", "--compile", "--production", "--compile-autoload-package-json",
          entry, "--outfile", outfile,
        ],
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
        hostRoot: string | null;
        resolverInstalled: boolean;
      };

      expect(result.importMetaDir.replaceAll("\\", "/")).toMatch(/\/(~BUN|\$bunfs)\/root$/i);
      expect(result.hostRoot).toBeNull();
      expect(result.resolverInstalled).toBe(true);
    } finally {
      rmSync(entry, { force: true });
      rmSync(outfile, { force: true });
    }
  });
});
