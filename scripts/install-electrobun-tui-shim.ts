import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

type TargetOs = "darwin" | "linux" | "win";

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

const MACOS_SHIM = `#!/bin/sh
set -eu

SOURCE="$0"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$SOURCE_DIR/$SOURCE" ;;
  esac
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
CONTENTS_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$CONTENTS_DIR/MacOS"
exec "./bun" "$CONTENTS_DIR/Resources/gloomberb-tui/tui-entry.js" "$@"
`;

const LINUX_SHIM = `#!/bin/sh
set -eu

SOURCE="$0"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$SOURCE_DIR/$SOURCE" ;;
  esac
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
APP_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR/bin"
exec "./bun" "$APP_DIR/Resources/gloomberb-tui/tui-entry.js" "$@"
`;

const WINDOWS_CMD_SHIM = `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%.."
pushd "%APP_DIR%\\bin" >nul
"%APP_DIR%\\bin\\bun.exe" "%APP_DIR%\\Resources\\gloomberb-tui\\tui-entry.js" %*
set "GLOOMBERB_EXIT_CODE=%ERRORLEVEL%"
popd >nul
exit /b %GLOOMBERB_EXIT_CODE%
`;

function appBundlesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".app"))
    .map((entry) => join(dir, entry));
}

function desktopBundlesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "Resources")))
    .map((entry) => join(dir, entry.name));
}

function nativeFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return nativeFilesIn(path);
    if (entry.isFile() && (entry.name.endsWith(".dylib") || entry.name.endsWith(".node"))) return [path];
    return [];
  });
}

function signNativeFiles(dir: string): void {
  const developerId = process.env.ELECTROBUN_DEVELOPER_ID;
  if (process.platform !== "darwin" || !developerId) return;

  for (const file of nativeFilesIn(dir)) {
    const mode = statSync(file).mode;
    chmodSync(file, mode | 0o755);

    const signed = Bun.spawnSync({
      cmd: ["codesign", "--force", "--timestamp", "--options", "runtime", "--sign", developerId, file],
      stdout: "inherit",
      stderr: "inherit",
    });

    if (signed.exitCode !== 0) {
      process.exit(signed.exitCode ?? 1);
    }
  }
}

function targetOs(): TargetOs {
  const electrobunOs = process.env.ELECTROBUN_OS;
  if (electrobunOs === "win" || electrobunOs === "linux" || electrobunOs === "darwin") {
    return electrobunOs;
  }
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function targetArch(): "arm64" | "x64" {
  if (process.env.ELECTROBUN_ARCH === "x64") return "x64";
  if (process.env.ELECTROBUN_ARCH === "arm64") return "arm64";
  return process.arch === "arm64" ? "arm64" : "x64";
}

function nodePlatformForTarget(os: TargetOs): "darwin" | "linux" | "win32" {
  return os === "win" ? "win32" : os;
}

function resourcesPathForBundle(bundlePath: string, os: TargetOs): string {
  return os === "darwin"
    ? join(bundlePath, "Contents", "Resources")
    : join(bundlePath, "Resources");
}

function runtimePathForBundle(bundlePath: string, os: TargetOs): string {
  return os === "darwin"
    ? join(bundlePath, "Contents", "MacOS")
    : join(bundlePath, "bin");
}

function bundleCandidates(os: TargetOs): string[] {
  const buildDir = process.env.ELECTROBUN_BUILD_DIR ?? "";
  const appName = process.env.ELECTROBUN_APP_NAME ?? "";
  const candidates = [
    process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH,
    os === "darwin" || !buildDir || !appName ? undefined : join(buildDir, appName),
    ...(os === "darwin" ? appBundlesIn(buildDir) : desktopBundlesIn(buildDir)),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

function installShim(runtimePath: string, resourcesPath: string, os: TargetOs): void {
  if (os === "win") {
    const shimPath = join(runtimePath, "gloomberb.cmd");
    writeFileSync(shimPath, WINDOWS_CMD_SHIM);
    console.log(`Installed TUI shim: ${shimPath}`);
    return;
  }

  const shimPath = os === "darwin"
    ? join(resourcesPath, "gloomberb")
    : join(runtimePath, "gloomberb");
  writeFileSync(shimPath, os === "darwin" ? MACOS_SHIM : LINUX_SHIM);
  chmodSync(shimPath, 0o755);
  console.log(`Installed TUI shim: ${shimPath}`);
}

function normalizeWindowsExecutableNames(runtimePath: string): void {
  const launcherPath = join(runtimePath, "launcher");
  const launcherExePath = join(runtimePath, "launcher.exe");
  if (existsSync(launcherPath) && !existsSync(launcherExePath)) {
    renameSync(launcherPath, launcherExePath);
    console.log(`Renamed Windows launcher: ${launcherExePath}`);
  }
}

function assertWindowsIconFile(path: string): void {
  const header = readFileSync(path).subarray(0, 4);
  if (header.length < 4 || header[0] !== 0 || header[1] !== 0 || header[2] !== 1 || header[3] !== 0) {
    throw new Error(`Windows icon is not a valid ICO file: ${path}`);
  }
}

function createWindowsIcon(resourcesPath: string): string {
  const sourceIcoPath = join(process.cwd(), "src", "assets", "gloomberb-logo-windows.ico");
  const pngToIcoCli = join(process.cwd(), "node_modules", "png-to-ico", "bin", "cli.js");
  const sourcePngPath = join(process.cwd(), "src", "assets", "gloomberb-logo-windows.png");
  const iconPath = join(resourcesPath, "gloomberb-logo.ico");
  const appIconPath = join(resourcesPath, "app.ico");
  if (existsSync(sourceIcoPath)) {
    assertWindowsIconFile(sourceIcoPath);
    cpSync(sourceIcoPath, iconPath, { dereference: true });
    cpSync(sourceIcoPath, appIconPath, { dereference: true });
    return iconPath;
  }

  const converted = Bun.spawnSync({
    cmd: [process.execPath, pngToIcoCli, sourcePngPath],
    stdout: "pipe",
    stderr: "inherit",
  });
  if (converted.exitCode !== 0) {
    process.exit(converted.exitCode ?? 1);
  }
  const iconBytes = Uint8Array.from(converted.stdout);
  writeFileSync(iconPath, iconBytes);
  writeFileSync(appIconPath, iconBytes);
  assertWindowsIconFile(iconPath);
  assertWindowsIconFile(appIconPath);
  return iconPath;
}

function rceditExecutablePath(): string {
  const rceditBinDir = join(process.cwd(), "node_modules", "rcedit", "bin");
  const rceditX64Path = join(rceditBinDir, "rcedit-x64.exe");
  return existsSync(rceditX64Path) ? rceditX64Path : join(rceditBinDir, "rcedit.exe");
}

function embedWindowsIcons(runtimePath: string, resourcesPath: string): void {
  const iconPath = createWindowsIcon(resourcesPath);
  const rceditPath = rceditExecutablePath();
  for (const exeName of ["launcher.exe", "bun.exe"]) {
    const exePath = join(runtimePath, exeName);
    if (!existsSync(exePath)) continue;
    const edited = Bun.spawnSync({
      cmd: [rceditPath, exePath, "--set-icon", iconPath],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (edited.exitCode !== 0) {
      process.exit(edited.exitCode ?? 1);
    }
    console.log(`Embedded Windows icon: ${exePath}`);
  }
}

const os = targetOs();
const arch = targetArch();
const nativeCorePackageName = `core-${nodePlatformForTarget(os)}-${arch}`;
const nativeCorePackagePath = join(process.cwd(), "node_modules", "@opentui", nativeCorePackageName);

if (!existsSync(nativeCorePackagePath)) {
  console.error(`Missing OpenTUI native package: ${nativeCorePackagePath}`);
  process.exit(1);
}

for (const bundlePath of bundleCandidates(os)) {
  const resourcesPath = resourcesPathForBundle(bundlePath, os);
  if (!existsSync(resourcesPath)) continue;

  const runtimePath = runtimePathForBundle(bundlePath, os);
  const tuiBundleDir = join(resourcesPath, "gloomberb-tui");
  rmSync(tuiBundleDir, { recursive: true, force: true });
  mkdirSync(tuiBundleDir, { recursive: true });

  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      join(process.cwd(), "src", "renderers", "electrobun", "bun", "tui-entry.ts"),
      "--target=bun",
      `--outdir=${tuiBundleDir}`,
      ...OPEN_TUI_NATIVE_PACKAGES.map((packageName) => `--external=${packageName}`),
    ],
    stdout: "inherit",
    stderr: "inherit",
  });

  if (build.exitCode !== 0) {
    process.exit(1);
  }

  const nativeCoreDestPath = join(tuiBundleDir, "node_modules", "@opentui", nativeCorePackageName);
  rmSync(nativeCoreDestPath, { recursive: true, force: true });
  mkdirSync(join(tuiBundleDir, "node_modules", "@opentui"), { recursive: true });
  cpSync(nativeCorePackagePath, nativeCoreDestPath, { recursive: true, dereference: true });
  signNativeFiles(nativeCoreDestPath);

  if (os === "win") {
    normalizeWindowsExecutableNames(runtimePath);
    embedWindowsIcons(runtimePath, resourcesPath);
  }

  installShim(runtimePath, resourcesPath, os);
}
