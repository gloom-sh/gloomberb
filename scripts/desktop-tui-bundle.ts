import { join } from "path";

const rootDir = join(import.meta.dir, "..");

/**
 * The render libraries the desktop's terminal bundle leaves out of itself.
 * They are native files, so each build copies the one for its target beside
 * the bundle (`node_modules/@opentui/<package>`).
 */
const OPEN_TUI_NATIVE_PACKAGES = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
];

/**
 * Bundles the terminal the desktop app ships (`gloom` in the app) into
 * `outdir`, as `tui-entry.js` beside its split chunks, and returns the exit
 * code of the build, `quiet` leaving its list of chunks out of the output.
 *
 * Production React and JSX, as the standalone binary ships (see build.ts
 * for why it takes `--production` rather than NODE_ENV): the development
 * build is twice the size and every launch of the desktop CLI paid to load it.
 * The release build (install-electrobun-tui-shim.ts) and the CI check that
 * loads registry plugins in it (check-packaged-registry-plugins.ts) both call
 * this, so the check cannot drift from what ships.
 */
export function buildDesktopTuiBundle(outdir: string, options: { quiet?: boolean } = {}): number {
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      join(rootDir, "src", "renderers", "electrobun", "bun", "tui-entry.ts"),
      "--target=bun",
      "--production",
      "--splitting",
      `--outdir=${outdir}`,
      ...OPEN_TUI_NATIVE_PACKAGES.map((packageName) => `--external=${packageName}`),
    ],
    cwd: rootDir,
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: "inherit",
  });
  return build.exitCode ?? 1;
}
