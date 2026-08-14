import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { OPEN_TUI_RUNTIME_SMOKE_COMMAND } from "../src/cli/native-smoke";

const rootDir = join(import.meta.dir, "..");
const smokeDir = mkdtempSync(join(tmpdir(), "gloomberb-global-upgrade-"));
const installDir = join(smokeDir, "bun-install");
const packageDir = join(smokeDir, "package");
const archiveName = "gloomberb-current.tgz";
const archivePath = join(smokeDir, archiveName);
const smokeEnvironment = { ...process.env, BUN_INSTALL: installDir };

async function run(command: string[], cwd = rootDir): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    env: smokeEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode === 0) return;
  throw new Error([
    `Command failed (${exitCode}): ${command.join(" ")}`,
    stdout.trim(),
    stderr.trim(),
  ].filter(Boolean).join("\n"));
}

try {
  mkdirSync(packageDir);
  const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    patchedDependencies?: Record<string, string>;
  };
  delete packageJson.patchedDependencies;
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const entry of ["bin", "src", "patches"]) {
    cpSync(join(rootDir, entry), join(packageDir, entry), { recursive: true });
  }

  await run([
    "bun",
    "pm",
    "pack",
    "--filename",
    archivePath,
    "--ignore-scripts",
    "--quiet",
  ], packageDir);
  await run(["bun", "install", "--global", "gloomberb@0.5.0"]);

  const globalNodeModules = join(installDir, "install", "global", "node_modules");
  const staleBackupDir = join(smokeDir, "stale-opentui");
  const oldCoreDir = join(globalNodeModules, "@opentui", "core");
  const oldReactDir = join(globalNodeModules, "@opentui", "react");
  const addOnPaths: Array<readonly [string, string]> = [
    [join(globalNodeModules, "@opentui-ui", "dialog"), join(staleBackupDir, "dialog")],
    [join(globalNodeModules, "@opentui-ui", "toast"), join(staleBackupDir, "toast")],
    [join(globalNodeModules, "opentui-spinner"), join(staleBackupDir, "spinner")],
  ];
  if (!existsSync(oldCoreDir) || !existsSync(oldReactDir) || addOnPaths.some(([source]) => !existsSync(source))) {
    throw new Error("The 0.5.0 fixture did not install the expected OpenTUI dependency graph.");
  }
  cpSync(oldCoreDir, join(staleBackupDir, "core"), { recursive: true });
  cpSync(oldReactDir, join(staleBackupDir, "react"), { recursive: true });
  for (const [source, backup] of addOnPaths) cpSync(source, backup, { recursive: true });
  // Bun treats a local tarball replacement for a recorded global registry package as a
  // dependency loop. Forget only the manifest entry while preserving the 0.5.0 files
  // and dependency residue that this regression needs to exercise.
  const globalPackageJsonPath = join(installDir, "install", "global", "package.json");
  const globalPackageJson = JSON.parse(readFileSync(globalPackageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  delete globalPackageJson.dependencies?.gloomberb;
  writeFileSync(globalPackageJsonPath, `${JSON.stringify(globalPackageJson, null, 2)}\n`);

  await run(["bun", "install", "--global", archivePath]);

  // Recreate the exact stale peer layout from #510 deterministically. The fixed
  // runtime must ignore these old nested OpenTUI copies even when they remain on disk.
  for (const [destination, backup] of addOnPaths) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(backup, destination, { recursive: true });
    const nestedOpenTui = join(destination, "node_modules", "@opentui");
    mkdirSync(nestedOpenTui, { recursive: true });
    cpSync(join(staleBackupDir, "core"), join(nestedOpenTui, "core"), { recursive: true });
    cpSync(join(staleBackupDir, "react"), join(nestedOpenTui, "react"), { recursive: true });
  }

  const installedPackage = JSON.parse(readFileSync(
    join(installDir, "install", "global", "node_modules", "gloomberb", "package.json"),
    "utf8",
  )) as { dependencies?: Record<string, string> };
  const incompatiblePackages = ["@opentui-ui/dialog", "@opentui-ui/toast", "opentui-spinner"];
  const retained = incompatiblePackages.filter((name) => installedPackage.dependencies?.[name]);
  if (retained.length > 0) {
    throw new Error(`Current package still depends on incompatible OpenTUI add-ons: ${retained.join(", ")}`);
  }

  const executable = join(installDir, "bin", process.platform === "win32" ? "gloomberb.exe" : "gloomberb");
  await run([executable, OPEN_TUI_RUNTIME_SMOKE_COMMAND], smokeDir);
  console.log("Global upgrade smoke passed: gloomberb 0.5.0 to the current package loaded the OpenTUI runtime graph.");
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
