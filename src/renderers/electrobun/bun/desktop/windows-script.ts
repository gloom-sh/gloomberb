import { readFile, writeFile } from "fs/promises";

/**
 * PowerShell scripts the Windows app leaves to finish what it cannot do while
 * it runs: its own files are locked until it quits.
 */

/** How long a script has to say it started before the app stops waiting and keeps running. */
const SCRIPT_START_TIMEOUT_MS = 20_000;

/** `value` as a single-quoted PowerShell string. */
export function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** PowerShell 5.1, which every supported Windows has, running `script` hidden and without the user's profile. */
function powershellCommand(script: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script];
}

/**
 * Writes `text` as a script for PowerShell 5.1: with Windows line ends, and
 * with a byte order mark, without which it reads the file in the system code
 * page and garbles a path with an accent in it.
 */
export async function writePowerShellScript(path: string, text: string): Promise<void> {
  await writeFile(path, `\uFEFF${text.replaceAll(/\r?\n/g, "\r\n")}`, "utf8");
}

async function startedScript(log: string): Promise<boolean> {
  const deadline = Date.now() + SCRIPT_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await readFile(log, "utf8").catch(() => "")).includes(" started ")) return true;
    await Bun.sleep(250);
  }
  return false;
}

function schtasks(...args: string[]): void {
  const result = Bun.spawnSync(["schtasks.exe", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  if (!result.success) throw new Error(`schtasks ${args[0]}: ${result.stderr.toString().trim()}`);
}

/**
 * Runs `script` from the scheduled task `taskName`, which outlives the app (a
 * child of its process dies with it), and resolves once the script has
 * written " started " to `log`: only then may the app quit for it. The script
 * removes the task. Throws, with the task gone, when it could not be
 * scheduled or did not start.
 */
export async function runScriptAfterExit(script: string, log: string, taskName: string): Promise<void> {
  const command = powershellCommand(script).map((part) => (part === script ? `"${part}"` : part)).join(" ");
  try {
    schtasks("/create", "/tn", taskName, "/tr", command, "/sc", "once", "/st", "00:00", "/f");
    schtasks("/run", "/tn", taskName);
    if (!(await startedScript(log))) throw new Error("the script did not start");
  } catch (error) {
    try { schtasks("/delete", "/tn", taskName, "/f"); } catch { /* Intentional ignore: never created. */ }
    throw error;
  }
}

/** Runs `script` in the background, as a child of the app; resolves to its exit code. */
export async function runScriptInBackground(script: string): Promise<number> {
  const child = Bun.spawn(powershellCommand(script), { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  return await child.exited;
}
