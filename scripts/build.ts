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
import { detectLinuxLibc, type LinuxLibc } from "../src/utils/linux-libc";

const rootDir = join(import.meta.dir, "..");
const RELEASE_API_URL = "https://api.gloom.sh";
/** The pane page's archive and the module that hands it to the CLI, shared by every target. */
const SHOT_VIEW_ARCHIVE = ".gloomberb-shot-view.json.gz";
const SHOT_VIEW_MODULE = ".gloomberb-shot-view.ts";

interface BuildTarget {
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
  /** Linux only: which C library the binary and its render library link against. */
  libc?: LinuxLibc;
  bunOs: "darwin" | "linux" | "windows";
  extension: "" | ".exe";
  nativePackageName: string;
}

const targets: BuildTarget[] = [
  { os: "darwin", arch: "arm64", bunOs: "darwin", extension: "", nativePackageName: "@opentui/core-darwin-arm64" },
  { os: "darwin", arch: "x64", bunOs: "darwin", extension: "", nativePackageName: "@opentui/core-darwin-x64" },
  { os: "linux", arch: "x64", libc: "glibc", bunOs: "linux", extension: "", nativePackageName: "@opentui/core-linux-x64" },
  { os: "linux", arch: "arm64", libc: "glibc", bunOs: "linux", extension: "", nativePackageName: "@opentui/core-linux-arm64" },
  // Alpine and other musl systems. Named gloomberb-linux-<arch>-musl; the installer and the updater pick them there.
  { os: "linux", arch: "x64", libc: "musl", bunOs: "linux", extension: "", nativePackageName: "@opentui/core-linux-x64-musl" },
  { os: "linux", arch: "arm64", libc: "musl", bunOs: "linux", extension: "", nativePackageName: "@opentui/core-linux-arm64-musl" },
  { os: "windows", arch: "x64", bunOs: "windows", extension: ".exe", nativePackageName: "@opentui/core-win32-x64" },
];

/** `linux-x64`, `linux-x64-musl`: the asset name without `gloomberb-` and the extension. */
function targetName({ os, arch, libc }: BuildTarget): string {
  return `${os}-${arch}${libc === "musl" ? "-musl" : ""}`;
}

/**
 * The Alpine image a musl binary is smoke tested in when the build host runs
 * glibc: plain Alpine plus libstdc++, which every musl Bun binary links.
 */
const MUSL_SMOKE_BASE_IMAGE = "alpine:3.22";
const MUSL_SMOKE_IMAGE = "gloomberb-musl-smoke:alpine-3.22";

const args = process.argv.slice(2);
const buildAll = args.includes("--all");
/** `--target linux-x64-musl` (repeatable) builds the named targets instead of the host's. */
const requestedTargets = args.flatMap((arg, index) => {
  if (arg === "--target") return args[index + 1] ? [args[index + 1]!] : [];
  return arg.startsWith("--target=") ? [arg.slice("--target=".length)] : [];
});

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

/**
 * What runs a target's binary on this host: nothing in front of it when the
 * host can run it, an Alpine container for a musl binary built on glibc, and
 * null when it cannot run here.
 */
async function smokeRunner(target: BuildTarget, smokeDir: string): Promise<string[] | null> {
  if (!canRunTarget(target.os, target.arch)) return null;
  if (target.os !== "linux" || target.libc === (detectLinuxLibc() ?? "glibc")) return [];
  if (target.libc !== "musl") return null;
  const container = Bun.which("docker") ?? Bun.which("podman");
  if (!container) return null;
  await runProcess(
    [container, "build", "--quiet", "--tag", MUSL_SMOKE_IMAGE, "-"],
    `Failed to build the ${MUSL_SMOKE_IMAGE} smoke test image`,
    { stdin: new Blob([`FROM ${MUSL_SMOKE_BASE_IMAGE}\nRUN apk add --no-cache libstdc++\n`]), stdout: "ignore" },
  );
  // Read-only, so the container's root user leaves nothing in the smoke folder.
  return [container, "run", "--rm", "--volume", `${smokeDir}:${smokeDir}:ro`, "--workdir", smokeDir, MUSL_SMOKE_IMAGE];
}

interface SmokeCheck {
  /** The binary by default. */
  command?: string;
  args: string[];
  /** Added to the environment for this check. */
  env?: Record<string, string>;
  /** Runs this check under another runner than the target's. */
  runner?: string[];
  failureMessage: string;
}

/**
 * Runs a command in its own mount namespace with a noexec tmpfs over `dir`,
 * or null where unprivileged user namespaces cannot mount one (Linux only,
 * and some distributions restrict them).
 */
async function noexecTempRunner(dir: string): Promise<string[] | null> {
  if (process.platform !== "linux" || !Bun.which("unshare")) return null;
  mkdirSync(dir, { recursive: true });
  const runner = [
    "unshare", "--user", "--map-root-user", "--mount",
    "sh", "-c", 'mount -t tmpfs -o noexec,size=64m tmpfs "$0" && exec "$@"', dir,
  ];
  const code = await runProcess([...runner, "true"], "", { stdout: "ignore", stderr: "ignore" }, true);
  return code === 0 ? runner : null;
}

async function smokeTestBinary(outfile: string, target: BuildTarget) {
  const { os } = target;
  const smokeDir = mkdtempSync(join(tmpdir(), "gloomberb-smoke-"));
  const runner = await smokeRunner(target, smokeDir);
  if (!runner) {
    rmSync(smokeDir, { recursive: true, force: true });
    const reason = !canRunTarget(target.os, target.arch)
      ? `on ${process.platform}-${process.arch}`
      : target.libc === "musl"
        ? "without docker or podman to run it in Alpine"
        : `on a ${detectLinuxLibc()} host`;
    console.log(`Skipping smoke test for ${targetName(target)} ${reason}`);
    return;
  }

  console.log(runner.length > 0 ? `Smoke testing packaged binary in ${MUSL_SMOKE_IMAGE}...` : "Smoke testing packaged binary...");
  // Named as installs from before the rename have it, so the run below also
  // checks that the binary adds the gloom command beside itself.
  const smokeBinary = join(smokeDir, os === "windows" ? "gloomberb.exe" : "gloomberb");
  copyFileSync(outfile, smokeBinary);
  if (os !== "windows") chmodSync(smokeBinary, 0o755);

  // Bun writes the render library to its temp folder before loading it. With
  // a folder that cannot take the file, or one mounted noexec, the binary
  // loads a copy from the Gloom folder instead.
  const inContainer = runner.length > 0;
  const missingTemp = join(smokeDir, "missing-temp");
  const noexecTemp = join(smokeDir, "noexec-temp");
  const noexec = inContainer ? null : await noexecTempRunner(noexecTemp);
  if (!inContainer && !noexec) console.log("Skipping the noexec temp folder check: no unprivileged mount namespace here");

  const checks: SmokeCheck[] = [
    {
      args: [OPEN_TUI_NATIVE_SMOKE_COMMAND],
      failureMessage: `Packaged binary failed to load OpenTUI native package: ${outfile}`,
    },
    {
      args: [OPEN_TUI_NATIVE_SMOKE_COMMAND],
      env: {
        BUN_TMPDIR: missingTemp,
        TMPDIR: missingTemp,
        // The container mounts the smoke folder read-only.
        GLOOMBERB_HOME: inContainer ? "/tmp/gloomberb-smoke-home" : join(smokeDir, "home-missing-temp"),
      },
      failureMessage: `Packaged binary failed to load OpenTUI when its temp folder cannot take the library: ${outfile}`,
    },
    ...(noexec ? [{
      runner: noexec,
      args: [OPEN_TUI_NATIVE_SMOKE_COMMAND],
      env: { BUN_TMPDIR: noexecTemp, TMPDIR: noexecTemp, GLOOMBERB_HOME: join(smokeDir, "home-noexec-temp") },
      failureMessage: `Packaged binary failed to load OpenTUI with a noexec temp folder: ${outfile}`,
    }] : []),
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
    // Symlinks need extra rights on Windows, where the desktop installer ships
    // both commands instead, and the container run mounts the folder read-only.
    ...(os === "windows" || runner.length > 0 ? [] : [{
      command: join(smokeDir, "gloom"),
      args: ["help"],
      failureMessage: `Packaged binary did not add the gloom command beside gloomberb: ${outfile}`,
    }]),
  ];
  let failureMessage: string | undefined;

  try {
    for (const check of checks) {
      const checkRunner = check.runner ?? runner;
      // A container does not see this process's environment, so it gets the check's through `env`.
      const envInContainer = check.env && checkRunner === runner && inContainer
        ? ["env", ...Object.entries(check.env).map(([name, value]) => `${name}=${value}`)]
        : [];
      const code = await runProcess(
        [...checkRunner, ...envInContainer, check.command ?? smokeBinary, ...check.args],
        check.failureMessage,
        { cwd: smokeDir, stdout: "ignore", ...(check.env && !envInContainer.length ? { env: { ...process.env, ...check.env } } : {}) },
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

function buildCompileEntrySource(renderLibModule: string): string {
  return [
    // Points @opentui/core at the musl library on musl before anything loads it.
    `import "../src/cli/opentui-libc.ts";`,
    `import "./${renderLibModule}";`,
    // Before the CLI, so the page is in place before any command runs.
    `import "./${SHOT_VIEW_MODULE}";`,
    `import "../src/cli/entry.ts";`,
    "",
  ].join("\n");
}

function isInstalled(packageName: string): boolean {
  try {
    Bun.resolveSync(packageName, rootDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Embeds the target's render library and tells the binary where it sits
 * inside it, for the copy it loads from the Gloom folder when the temp folder
 * cannot run it (src/renderers/opentui/render-lib.ts). @opentui/core picks the
 * glibc or musl library at runtime, so a Linux binary names both when the
 * build host has them.
 */
function buildRenderLibModuleSource({ os, arch, nativePackageName }: BuildTarget): string {
  const register = `import { useEmbeddedRenderLib } from "../src/renderers/opentui/render-lib.ts";`;
  if (os !== "linux") {
    return [
      `import renderLib from ${JSON.stringify(nativePackageName)};`,
      register,
      "useEmbeddedRenderLib({ path: renderLib });",
      "",
    ].join("\n");
  }
  const glibcPackage = `@opentui/core-linux-${arch}`;
  const muslPackage = `${glibcPackage}-musl`;
  const hasGlibc = glibcPackage === nativePackageName || isInstalled(glibcPackage);
  const hasMusl = muslPackage === nativePackageName || isInstalled(muslPackage);
  return [
    ...(hasGlibc ? [`import glibcRenderLib from ${JSON.stringify(glibcPackage)};`] : []),
    ...(hasMusl ? [`import muslRenderLib from ${JSON.stringify(muslPackage)};`] : []),
    register,
    `useEmbeddedRenderLib({ path: ${hasGlibc ? "glibcRenderLib" : "muslRenderLib"}${hasMusl ? ", musl: muslRenderLib" : ""} });`,
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
  const { os, arch, libc, bunOs, extension } = targetConfig;
  mkdirSync(join(rootDir, "dist"), { recursive: true });
  const name = targetName(targetConfig);
  const outfile = join(rootDir, `dist/gloomberb-${name}${extension}`);
  const compileEntry = join(rootDir, "dist", `.gloomberb-compile-entry-${name}.ts`);
  const renderLibModule = `.gloomberb-render-lib-${name}.ts`;
  const target = `bun-${bunOs}-${arch}${libc === "musl" ? "-musl" : ""}`;
  console.log(`Building ${target}...`);
  writeFileSync(join(rootDir, "dist", renderLibModule), buildRenderLibModuleSource(targetConfig));
  writeFileSync(compileEntry, buildCompileEntrySource(renderLibModule));
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
      "bun", "build", "--compile", "--production", "--splitting", "--compile-autoload-package-json",
      `--target=${target}`, compileEntry, `--outfile=${outfile}`,
    ],
    `Failed to build ${target}`,
    { env: { ...process.env, GLOOMBERB_API_URL: RELEASE_API_URL } },
    true,
  );
  rmSync(compileEntry, { force: true });
  rmSync(join(rootDir, "dist", renderLibModule), { force: true });
  if (buildExitCode !== 0) {
    console.error(`Failed to build ${target}`);
    process.exit(1);
  }

  if (os === "darwin") {
    await signDarwinBinary(outfile);
  }

  await smokeTestBinary(outfile, targetConfig);

  const compressedPath = compressGzip(outfile);
  console.log(`  -> ${compressedPath}`);
}

function selectedTargets(): BuildTarget[] {
  if (buildAll) return targets;
  if (requestedTargets.length > 0) {
    return requestedTargets.map((name) => {
      const target = targets.find((candidate) => targetName(candidate) === name);
      if (!target) {
        console.error(`Unknown build target: ${name}. Known: ${targets.map(targetName).join(", ")}`);
        process.exit(1);
      }
      return target;
    });
  }
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const libc = os === "linux" ? detectLinuxLibc() ?? "glibc" : undefined;
  const target = targets.find((candidate) => candidate.os === os && candidate.arch === arch && candidate.libc === libc);
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
