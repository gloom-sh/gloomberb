import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
  PLUGIN_HOST_SMOKE_COMMAND,
  SHOT_VIEW_SMOKE_COMMAND,
} from "../src/cli/native-smoke";
import { buildShotView, packShotView } from "../src/cli/desktop-pane-shot-view";

const rootDir = join(import.meta.dir, "..");
const RELEASE_API_URL = "https://api.gloom.sh";
/** The pane page's archive and the module that hands it to the CLI, shared by every target. */
const SHOT_VIEW_ARCHIVE = ".gloomberb-shot-view.json.gz";
const SHOT_VIEW_MODULE = ".gloomberb-shot-view.ts";

interface BuildTarget {
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
  bunOs: "darwin" | "linux" | "windows";
  extension: "" | ".exe";
  nativePackageName: string;
}

const targets: BuildTarget[] = [
  { os: "darwin", arch: "arm64", bunOs: "darwin", extension: "", nativePackageName: "@opentui/core-darwin-arm64" },
  { os: "darwin", arch: "x64", bunOs: "darwin", extension: "", nativePackageName: "@opentui/core-darwin-x64" },
  { os: "linux", arch: "x64", bunOs: "linux", extension: "", nativePackageName: "@opentui/core-linux-x64" },
  { os: "linux", arch: "arm64", bunOs: "linux", extension: "", nativePackageName: "@opentui/core-linux-arm64" },
  { os: "windows", arch: "x64", bunOs: "windows", extension: ".exe", nativePackageName: "@opentui/core-win32-x64" },
];

const args = process.argv.slice(2);
const buildAll = args.includes("--all");

async function runProcess(
  command: string[],
  failureMessage: string,
  options: Parameters<typeof Bun.spawn>[1] = {},
  allowFailure = false,
) {
  const proc = Bun.spawn(command, {
    cwd: rootDir,
    stdout: "inherit",
    stderr: "inherit",
    ...options,
  });
  const code = await proc.exited;
  if (code !== 0 && !allowFailure) {
    console.error(failureMessage);
    process.exit(1);
  }
  return code;
}

async function signDarwinBinary(outfile: string) {
  if (process.platform !== "darwin") {
    console.error("Failed to sign macOS binary: build darwin targets on macOS so codesign is available.");
    process.exit(1);
  }

  console.log("Signing macOS binary...");
  await runProcess(
    ["codesign", "--remove-signature", outfile],
    "",
    { stdout: "ignore", stderr: "ignore" },
    true,
  );
  await runProcess(
    ["codesign", "--force", "--sign", "-", outfile],
    `Failed to sign ${outfile}`,
  );
  await runProcess(
    ["codesign", "--verify", "--verbose=4", outfile],
    `Failed to verify signature for ${outfile}`,
  );
}

function canRunTarget(os: string, arch: string): boolean {
  const hostOs = process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "windows"
      : process.platform === "linux"
        ? "linux"
        : process.platform;
  const hostArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return hostOs === os && hostArch === arch;
}

function isRetryableCleanupError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String(error.code);
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function removeSmokeDir(smokeDir: string) {
  const delaysMs = process.platform === "win32" ? [0, 100, 250, 500, 1000] : [0];
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await Bun.sleep(delayMs);
    try {
      rmSync(smokeDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableCleanupError(error)) throw error;
    }
  }
  console.warn(`Could not remove smoke test directory ${smokeDir}:`, lastError);
}

async function smokeTestBinary(outfile: string, os: string, arch: string) {
  if (!canRunTarget(os, arch)) {
    console.log(`Skipping smoke test for ${os}-${arch} on ${process.platform}-${process.arch}`);
    return;
  }

  console.log("Smoke testing packaged binary...");
  const smokeDir = mkdtempSync(join(tmpdir(), "gloomberb-smoke-"));
  // Named as installs from before the rename have it, so the run below also
  // checks that the binary adds the gloom command beside itself.
  const smokeBinary = join(smokeDir, os === "windows" ? "gloomberb.exe" : "gloomberb");
  copyFileSync(outfile, smokeBinary);
  if (os !== "windows") chmodSync(smokeBinary, 0o755);

  const checks: Array<{ command?: string; args: string[]; failureMessage: string }> = [
    {
      args: [OPEN_TUI_NATIVE_SMOKE_COMMAND],
      failureMessage: `Packaged binary failed to load OpenTUI native package: ${outfile}`,
    },
    {
      args: [OPEN_TUI_RUNTIME_SMOKE_COMMAND],
      failureMessage: `Packaged binary failed to load the OpenTUI runtime graph: ${outfile}`,
    },
    {
      args: [PLUGIN_HOST_SMOKE_COMMAND],
      failureMessage: `Packaged binary failed to load an external plugin against its own runtime: ${outfile}`,
    },
    {
      args: [SHOT_VIEW_SMOKE_COMMAND],
      failureMessage: `Packaged binary is missing the page shot and rendered fn reports draw panes in: ${outfile}`,
    },
    {
      args: ["help"],
      failureMessage: `Packaged binary failed to launch: ${outfile}`,
    },
    // Symlinks need extra rights on Windows, where the desktop installer ships both commands instead.
    ...(os === "windows" ? [] : [{
      command: join(smokeDir, "gloom"),
      args: ["help"],
      failureMessage: `Packaged binary did not add the gloom command beside gloomberb: ${outfile}`,
    }]),
  ];
  let failureMessage: string | undefined;

  try {
    for (const check of checks) {
      const code = await runProcess(
        [check.command ?? smokeBinary, ...check.args],
        check.failureMessage,
        { cwd: smokeDir, stdout: "ignore" },
        true,
      );
      if (code !== 0) {
        failureMessage = check.failureMessage;
        break;
      }
    }
  } finally {
    await removeSmokeDir(smokeDir);
  }

  if (failureMessage) {
    console.error(failureMessage);
    process.exit(1);
  }
}

function buildCompileEntrySource(nativePackageName: string): string {
  return [
    `import ${JSON.stringify(nativePackageName)};`,
    // Before the CLI, so the page is in place before any command runs.
    `import "./${SHOT_VIEW_MODULE}";`,
    `import "../src/cli/entry.ts";`,
    "",
  ].join("\n");
}

/**
 * `shot` and rendered `fn` reports draw a pane in a browser page, which a
 * checkout builds from its sources on first use. A binary has no sources, so
 * the page is built here, once for every target since it runs in Chrome, and
 * embedded as one gzipped file the CLI reads when it draws a pane. Only the
 * pane and its data change per capture, and those go in the page's HTML.
 */
async function writeShotViewModule() {
  const distDir = join(rootDir, "dist");
  const viewDir = join(distDir, ".gloomberb-shot-view");
  rmSync(viewDir, { recursive: true, force: true });
  try {
    await buildShotView(viewDir, RELEASE_API_URL);
    writeFileSync(join(distDir, SHOT_VIEW_ARCHIVE), await packShotView(viewDir));
  } finally {
    rmSync(viewDir, { recursive: true, force: true });
  }
  writeFileSync(join(distDir, SHOT_VIEW_MODULE), [
    `import archive from "./${SHOT_VIEW_ARCHIVE}" with { type: "file" };`,
    `import { usePrebuiltShotView } from "../src/cli/desktop-pane-shot-view.ts";`,
    "usePrebuiltShotView(archive);",
    "",
  ].join("\n"));
}

function removeShotViewModule() {
  rmSync(join(rootDir, "dist", SHOT_VIEW_ARCHIVE), { force: true });
  rmSync(join(rootDir, "dist", SHOT_VIEW_MODULE), { force: true });
}

function compressGzip(path: string): string {
  const compressedPath = `${path}.gz`;
  const source = Uint8Array.from(readFileSync(path));
  const compressed = Uint8Array.from(gzipSync(source, { level: 9 }));
  writeFileSync(compressedPath, compressed);
  rmSync(path);
  return compressedPath;
}

async function build(targetConfig: BuildTarget) {
  const { os, arch, bunOs, extension, nativePackageName } = targetConfig;
  mkdirSync(join(rootDir, "dist"), { recursive: true });
  const outfile = join(rootDir, `dist/gloomberb-${os}-${arch}${extension}`);
  const compileEntry = join(rootDir, "dist", `.gloomberb-compile-entry-${os}-${arch}.ts`);
  const target = `bun-${bunOs}-${arch}`;
  console.log(`Building ${target}...`);
  writeFileSync(compileEntry, buildCompileEntrySource(nativePackageName));
  // `--production` is the only switch that flips both the JSX transform and
  // React itself to production builds. Setting NODE_ENV in the environment or
  // through --define leaves jsxDEV calls behind that resolve to nothing at
  // runtime, so the binary crashes on first render.
  //
  // A standalone executable does not read package.json files at runtime
  // unless told to, and without them a plugin's dependency that publishes an
  // `exports` map cannot be resolved from `~/.gloomberb/plugins/*/node_modules`
  // ("Cannot find package 'youtubei.js'" from the TV plugin, for one). The
  // plugin-host smoke below imports such a package so this flag stays.
  const buildExitCode = await runProcess(
    [
      "bun", "build", "--compile", "--production", "--compile-autoload-package-json",
      `--target=${target}`, compileEntry, `--outfile=${outfile}`,
    ],
    `Failed to build ${target}`,
    { env: { ...process.env, GLOOMBERB_API_URL: RELEASE_API_URL } },
    true,
  );
  rmSync(compileEntry, { force: true });
  if (buildExitCode !== 0) {
    console.error(`Failed to build ${target}`);
    process.exit(1);
  }

  if (os === "darwin") {
    await signDarwinBinary(outfile);
  }

  await smokeTestBinary(outfile, os, arch);

  const compressedPath = compressGzip(outfile);
  console.log(`  -> ${compressedPath}`);
}

function selectedTargets(): BuildTarget[] {
  if (buildAll) return targets;
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = targets.find((candidate) => candidate.os === os && candidate.arch === arch);
  if (!target) {
    console.error(`Unsupported build target: ${os}-${arch}`);
    process.exit(1);
  }
  return [target];
}

const buildTargets = selectedTargets();
mkdirSync(join(rootDir, "dist"), { recursive: true });
console.log("Building the pane page...");
await writeShotViewModule();
try {
  for (const t of buildTargets) {
    await build(t);
  }
} finally {
  removeShotViewModule();
}
