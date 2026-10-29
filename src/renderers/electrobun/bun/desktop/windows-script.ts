import { readFile, writeFile } from "fs/promises";

/**
 * PowerShell scripts the Windows app leaves to finish what it cannot do while
 * it runs: its own files are locked until it quits.
 */

/** How long a script has to answer before the app stops waiting and keeps running. */
const SCRIPT_START_TIMEOUT_MS = 20_000;

/**
 * `value` as a single-quoted PowerShell string. PowerShell also takes the
 * curly single quotes U+2018 to U+201B for quotes; doubling escapes each.
 */
export function psString(value: string): string {
  return `'${value.replace(/['\u2018-\u201B]/g, "$&$&")}'`;
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

/** What a script that runs after the app quits answered before the app quit for it. */
export type ScriptAnswer =
  /** It waits for the app to quit. */
  | { kind: "started" }
  /** It cannot run now, for a while: something it needs is in use. */
  | { kind: "busy"; reason: string }
  /** It cannot run. */
  | { kind: "declined"; reason: string };

/**
 * The script's answer in its log, a line `<time> started …`,
 * `<time> busy: …` or `<time> declined: …`; null before it wrote one.
 */
export function scriptAnswer(log: string): ScriptAnswer | null {
  for (const line of log.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\S+ (started|busy|declined)\b:? ?(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "started") return { kind: "started" };
    return { kind: match[1] === "busy" ? "busy" : "declined", reason: match[2]?.trim() ?? "" };
  }
  return null;
}

function schtasks(...args: string[]): void {
  const result = Bun.spawnSync(["schtasks.exe", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  if (!result.success) throw new Error(`schtasks ${args[0]}: ${result.stderr.toString().trim()}`);
}

/**
 * Runs `script` from the scheduled task `taskName`, which outlives the app (a
 * child of its process dies with it), and resolves to the answer it writes to
 * `log`: only on `started` may the app quit for it. The script removes the
 * task. When it does not answer in time, the app writes `cancel`, which keeps
 * a script that starts late from doing anything, and this throws with the
 * task gone, as it does when the task could not be made.
 */
export async function runScriptAfterExit(script: string, log: string, cancel: string, taskName: string): Promise<ScriptAnswer> {
  const command = powershellCommand(script).map((part) => (part === script ? `"${part}"` : part)).join(" ");
  try {
    schtasks("/create", "/tn", taskName, "/tr", command, "/sc", "once", "/st", "00:00", "/f");
    schtasks("/run", "/tn", taskName);
    const deadline = Date.now() + SCRIPT_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const answer = scriptAnswer(await readFile(log, "utf8").catch(() => ""));
      if (answer) return answer;
      await Bun.sleep(250);
    }
    await writeFile(cancel, "").catch(() => {});
    throw new Error("the script did not start");
  } catch (error) {
    try { schtasks("/delete", "/tn", taskName, "/f"); } catch { /* Intentional ignore: never made, or the script removed it. */ }
    throw error;
  }
}

/** Runs `script` in the background, as a child of the app; resolves to its exit code. */
export async function runScriptInBackground(script: string): Promise<number> {
  const child = Bun.spawn(powershellCommand(script), { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  return await child.exited;
}
