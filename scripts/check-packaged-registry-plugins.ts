import { spawnSync } from "child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { gunzipSync } from "zlib";
import { testAppEnv } from "./test-app-env";

import { buildDesktopTuiBundle } from "./desktop-tui-bundle";
import { type DoctorRun, type LoadProblem, isHostLinkError, loadProblems } from "./packaged-plugin-load";
import { annotate, cloneRegistryPlugins } from "./registry-plugins";

/**
 * Loads every plugin the registry lists in the terminal as it ships, and
 * fails when a plugin cannot link against the host that was packaged.
 *
 * check-registry-plugins.ts compiles the same plugins against this checkout,
 * and the terminal itself runs from source there. A packaged terminal is a
 * different host: the compiled binary and the desktop's terminal bundle serve
 * React and the `gloomberb/*` modules from inside the process, and v0.19.3 to
 * v0.19.5 shipped a binary that served React without its named exports, so
 * `import { useCallback } from "react"` failed in every plugin while every
 * check against sources passed.
 *
 *   bun scripts/check-packaged-registry-plugins.ts --terminal dist/gloomberb-linux-x64.gz --desktop-tui
 *
 * `--terminal <path>` is a terminal to load them in: a compiled binary, as
 * `scripts/build.ts` writes it (gzipped or not), or the `gloom` command of an
 * installed desktop app. `--desktop-tui` builds the desktop's terminal bundle
 * from this checkout (the build the desktop release runs) and loads them in
 * that, under the Bun that runs this script. Each terminal runs `plugin
 * doctor` on every plugin, in a folder of plugin checkouts with no link to a
 * host on disk, as an installed plugin has none in a packaged host.
 *
 * A plugin that does not load there fails the check when the host is to blame:
 * React or a `gloomberb/*` module missing an export or not resolving, or a
 * plugin that loads from this checkout's sources and not in the terminal.
 * The registry or GitHub unreachable, a dependency that does not install, a
 * plugin that is broken in its own right: a warning. The compile check names
 * a plugin that needs an export this checkout lacks.
 */

const rootDir = join(import.meta.dir, "..");
const DOCTOR_TIMEOUT_MS = 120_000;

interface Terminal {
  label: string;
  command: string[];
}

const args = process.argv.slice(2);
const terminalPaths: string[] = [];
let desktopTui = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--terminal") terminalPaths.push(args[++index] ?? "");
  else if (arg.startsWith("--terminal=")) terminalPaths.push(arg.slice("--terminal=".length));
  else if (arg === "--desktop-tui") desktopTui = true;
  else usage(`Unknown argument: ${arg}`);
}
if (terminalPaths.length === 0 && !desktopTui) usage("Name a terminal to load the plugins in.");
if (terminalPaths.includes("")) usage("--terminal needs a path.");
for (const path of terminalPaths) {
  if (!existsSync(resolve(path))) usage(`No terminal at ${path}.`);
}

function usage(reason: string): never {
  console.error(`${reason}\nUsage: bun scripts/check-packaged-registry-plugins.ts [--terminal <binary or .gz>]... [--desktop-tui]`);
  process.exit(2);
}

/** The terminal's own folder: a gzipped binary is unpacked beside nothing else, named as build.ts's smoke test names it. */
function prepareTerminals(workDir: string): Terminal[] {
  const terminals: Terminal[] = [];
  for (const [index, path] of terminalPaths.entries()) {
    const source = resolve(path);
    if (!source.endsWith(".gz")) {
      terminals.push({ label: basename(source), command: [source] });
      continue;
    }
    const dir = join(workDir, `terminal-${index}`);
    mkdirSync(dir, { recursive: true });
    const binary = join(dir, process.platform === "win32" ? "gloomberb.exe" : "gloomberb");
    writeFileSync(binary, gunzipSync(readFileSync(source)));
    chmodSync(binary, 0o755);
    terminals.push({ label: basename(source, ".gz"), command: [binary] });
  }

  if (desktopTui) {
    const bundleDir = join(workDir, "desktop-tui");
    mkdirSync(bundleDir, { recursive: true });
    if (buildDesktopTuiBundle(bundleDir, { quiet: true }) !== 0) throw new Error("The desktop terminal bundle did not build.");
    // The render library stays outside the bundle, beside it.
    const nativePackage = `core-${process.platform}-${process.arch}`;
    const nativeSource = join(rootDir, "node_modules", "@opentui", nativePackage);
    if (!existsSync(nativeSource)) throw new Error(`Missing OpenTUI native package: ${nativeSource}`);
    cpSync(nativeSource, join(bundleDir, "node_modules", "@opentui", nativePackage), { recursive: true, dereference: true });
    terminals.push({ label: "desktop terminal bundle", command: [process.execPath, join(bundleDir, "tui-entry.js")] });
  }
  return terminals;
}

function doctor(command: string[], pluginDir: string, home: string, cwd: string): DoctorRun {
  // `plugin doctor` takes a path by its slash, and Windows spells it with backslashes.
  const result = spawnSync(command[0]!, [...command.slice(1), "--json", "plugin", "doctor", pluginDir.replaceAll("\\", "/")], {
    cwd,
    env: testAppEnv({ GLOOMBERB_HOME: home }),
    encoding: "utf8",
    timeout: DOCTOR_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function describe(problem: LoadProblem): string {
  return `${problem.check}: ${problem.message.replace(/\s+/g, " ").slice(0, 400)}`;
}

const workDir = mkdtempSync(join(tmpdir(), "gloom-packaged-registry-plugins-"));
const failures: string[] = [];
let loaded = 0;
let listed = 0;

try {
  const terminals = prepareTerminals(workDir);
  const pluginsDir = join(workDir, "plugins");
  mkdirSync(pluginsDir);
  const result = await cloneRegistryPlugins(pluginsDir);
  listed = result.listed;

  // Neither the folder the terminals run in nor their Gloom folder is this checkout.
  const cwd = join(workDir, "cwd");
  mkdirSync(cwd);
  const home = join(workDir, "home");

  const unexplained: Array<{ id: string; dir: string; terminal: Terminal; problems: LoadProblem[] }> = [];
  for (const terminal of terminals) {
    for (const { id, dir } of result.cloned) {
      const problems = loadProblems(doctor(terminal.command, dir, home, cwd));
      if (problems.length === 0) {
        loaded += 1;
        console.log(`loaded ${id} in ${terminal.label}`);
      } else if (problems.some((problem) => isHostLinkError(problem.message))) {
        const hostProblem = problems.find((problem) => isHostLinkError(problem.message))!;
        failures.push(`${id} does not load in ${terminal.label}. ${describe(hostProblem)}`);
      } else {
        unexplained.push({ id, dir, terminal, problems });
      }
    }
  }

  // Anything else that failed is the plugin's or the host's: ask this
  // checkout's own terminal, which loads from sources. After every packaged
  // run, since it links the host into the plugin's folder.
  for (const { id, dir, terminal, problems } of unexplained) {
    const reference = loadProblems(doctor([process.execPath, join(rootDir, "src", "cli", "entry.ts")], dir, home, cwd));
    if (reference.length === 0) {
      failures.push(`${id} loads from this checkout's sources and not in ${terminal.label}. ${problems.map(describe).join("; ")}`);
    } else {
      annotate("warning", `${id} does not load in ${terminal.label}, nor from sources. ${problems.map(describe).join("; ")}`);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

for (const failure of failures) annotate("error", failure);
if (failures.length > 0) {
  console.log(`\n${failures.length} plugin${failures.length === 1 ? "" : "s"} failed to load in a packaged terminal. A packaged host serves React and the gloomberb/* modules from inside the process (src/plugins/host-modules.ts), and has to serve every export a plugin may import.`);
  process.exit(1);
}
if (loaded === 0) {
  annotate("warning", `No registry plugin loaded in a packaged terminal (${listed} listed); see the warnings above.`);
} else {
  console.log(`\nRegistry plugins load in the packaged terminal (${loaded} loads, ${listed} plugins listed).`);
}
