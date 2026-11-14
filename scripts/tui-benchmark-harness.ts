import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { testAppEnv } from "./test-app-env";

export async function runTmux(args: string[], check = true): Promise<void> {
  const env = testAppEnv();
  const command = args[0] === "new-session"
    ? [args[0], "-e", `GLOOMBERB_NO_TELEMETRY=${env.GLOOMBERB_NO_TELEMETRY}`, "-e", `DO_NOT_TRACK=${env.DO_NOT_TRACK}`, ...args.slice(1)]
    : args;
  const process = Bun.spawn(["tmux", ...command], { env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (check && exitCode !== 0) {
    throw new Error(`tmux ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

export async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Benchmark report was not written: ${path}`);
}

/**
 * Writes the config.json a fresh install starts from, setup finished.
 *
 * A fresh install records the plugins that moved out of the app as already
 * restored (the config store's first-run default). A profile without that
 * record reads as an upgrade from before they moved: every launch would first
 * clone and install each of them from GitHub and npm, holding the first frame
 * for as long as the network takes, and the benchmark would measure an app
 * with all of them loaded.
 */
export async function writeFreshInstallConfig(dataDir: string): Promise<void> {
  // Loaded here so scripts that only parse options do not load the app's modules.
  const [{ createDefaultConfig }, { EXTRACTED_PLUGINS }] = await Promise.all([
    import("../src/types/config"),
    import("../src/plugins/extracted-plugins"),
  ]);
  const config = {
    ...createDefaultConfig(dataDir),
    seededPlugins: EXTRACTED_PLUGINS.map((plugin) => plugin.id),
    onboardingComplete: true,
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Starts the terminal in a detached tmux session that keeps its last screen
 * when the terminal exits, so a launch that dies early can still be read.
 */
export async function startTerminalSession(
  session: string,
  options: { width: number; height: number; cwd: string },
  command: string,
): Promise<void> {
  await runTmux([
    "new-session", "-d", "-s", session, "-x", String(options.width), "-y", String(options.height), "-c", options.cwd, command,
    ";", "set-option", "-t", session, "remain-on-exit", "on",
  ]);
}

/**
 * Waits for the terminal to publish its remote-control endpoint, the sign it
 * is up. When it does not, the error says what the terminal shows and what it
 * is still running, so a launch that never comes up says where it stopped.
 */
export async function waitForTerminal(session: string, endpointPath: string, timeoutMs: number): Promise<void> {
  try {
    await waitForFile(endpointPath, timeoutMs);
  } catch {
    throw new Error(`The terminal did not come up within ${timeoutMs / 1000} s.\n${await describeSession(session)}`);
  }
}

async function describeSession(session: string): Promise<string> {
  const pane = await tmuxOutput(["display-message", "-p", "-t", session, "#{pane_dead}|#{pane_dead_status}|#{pane_pid}"]);
  if (pane === null) return "Its tmux session is gone.";
  const [dead, status, pid] = pane.trim().split("|");
  const screen = (await tmuxOutput(["capture-pane", "-p", "-t", session]))?.replace(/\n\s*\n/g, "\n").trim() || "(blank)";
  const root = Number(pid);
  const state = dead === "1"
    ? `It exited with status ${status}.`
    : `Still running:\n${(root > 1 ? processTree(root) : []).join("\n") || "(nothing)"}`;
  return `${state}\nScreen:\n${screen}`;
}

async function tmuxOutput(args: string[]): Promise<string | null> {
  const child = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return exitCode === 0 ? stdout : null;
}

/** `root` and every process under it, as running time and command line. */
function processTree(root: number): string[] {
  const listing = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,etime=,args="]).stdout.toString();
  const rows = listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsed: match[3]!, args: match[4]! }] : [];
  });
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.pid) || !tree.has(row.ppid)) continue;
      tree.add(row.pid);
      grew = true;
    }
  }
  return rows.filter((row) => tree.has(row.pid)).map((row) => `  ${row.elapsed}  ${row.args.slice(0, 200)}`);
}

export function takeOption(args: string[], name: string): string | undefined {
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
