import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
} from "../src/cli/native-smoke";

const rootDir = join(import.meta.dir, "..");

interface BuildTarget {
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
  bunOs: "darwin" | "linux" | "windows";
  extension: "" | ".exe";
  nativePackageName: string;
}

const targets: BuildTarget[] = [
  { os: "darwin", arch: "arm64", bunOs: "darwin", extension: "", nativePackageName: "@opentui/core-darwin-arm64" },
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

async function smokeTestBinary(outfile: string, os: string, arch: string) {
  if (!canRunTarget(os, arch)) {
    console.log(`Skipping smoke test for ${os}-${arch} on ${process.platform}-${process.arch}`);
    return;
  }

  console.log("Smoke testing packaged binary...");
  const smokeDir = mkdtempSync(join(tmpdir(), "gloomberb-smoke-"));
  const smokeBinary = join(smokeDir, os === "windows" ? "gloomberb.exe" : "gloomberb");
  copyFileSync(outfile, smokeBinary);
  if (os !== "windows") chmodSync(smokeBinary, 0o755);

  const checks = [
    {
      args: [OPEN_TUI_NATIVE_SMOKE_COMMAND],
      failureMessage: `Packaged binary failed to load OpenTUI native package: ${outfile}`,
    },
    {
      args: [OPEN_TUI_RUNTIME_SMOKE_COMMAND],
      failureMessage: `Packaged binary failed to load the OpenTUI runtime graph: ${outfile}`,
    },
    {
      args: ["help"],
      failureMessage: `Packaged binary failed to launch: ${outfile}`,
    },
  ];
  let failureMessage: string | undefined;

  try {
    for (const check of checks) {
      const code = await runProcess(
        [smokeBinary, ...check.args],
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
    rmSync(smokeDir, { recursive: true, force: true });
  }

  if (failureMessage) {
    console.error(failureMessage);
    process.exit(1);
  }
}

function buildCompileEntrySource(nativePackageName: string): string {
  return [
    `import ${JSON.stringify(nativePackageName)};`,
    `import "../src/cli/entry.ts";`,
    "",
  ].join("\n");
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
  const buildExitCode = await runProcess(
    ["bun", "build", "--compile", `--target=${target}`, compileEntry, `--outfile=${outfile}`],
    `Failed to build ${target}`,
    { env: { ...process.env, GLOOMBERB_API_URL: "https://api.gloom.sh" } },
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

if (buildAll) {
  for (const t of targets) {
    await build(t);
  }
} else {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = targets.find((candidate) => candidate.os === os && candidate.arch === arch);
  if (!target) {
    console.error(`Unsupported build target: ${os}-${arch}`);
    process.exit(1);
  }
  await build(target);
}
