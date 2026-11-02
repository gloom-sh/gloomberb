import { rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, win32 } from "path";
import { psString, runScriptAfterExit, writePowerShellScript } from "./windows-script";

/**
 * The folders the relaunch script finds `sleep` in, after whatever PATH the
 * app was started with: a terminal launch can hand it a PATH without them.
 */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function findMacAppBundle(execPath: string): string | null {
  let current = dirname(execPath);
  while (current && current !== dirname(current)) {
    if (current.endsWith(".app")) return current;
    current = dirname(current);
  }
  return null;
}

/** The running process, as far as opening it again goes. */
export interface RelaunchContext {
  platform: string;
  pid: number;
  execPath: string;
  /** What the app was started with, after the runtime (`process.argv.slice(1)`). */
  args: string[];
  cwd: string;
  /** PATH as the app sees it. */
  pathEnv: string;
  /** Where the app keeps its data when GLOOMBERB_HOME moves it. */
  home?: string;
}

interface RelaunchCommand {
  cmd: string[];
  /** Where it starts; unset keeps this process's folder. */
  cwd?: string;
  /** PATH for it; unset keeps this process's. */
  pathEnv?: string;
}

function currentProcess(): RelaunchContext {
  return {
    platform: process.platform,
    pid: process.pid,
    execPath: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    pathEnv: process.env.PATH ?? "",
    home: process.env.GLOOMBERB_HOME || undefined,
  };
}

/**
 * What opens the app again once `context.pid` has exited, on a Mac or Linux.
 * The script runs in `/` with the shell and `open` named by their full paths:
 * the launcher starts the app inside its bundle's `Contents/MacOS`, which a
 * rename to the app's new name takes away, and a spawn into a folder that is
 * gone fails as if the shell were missing (`ENOENT, posix_spawn 'sh'`).
 */
export function desktopRelaunchCommand(context: RelaunchContext, bundle?: string): RelaunchCommand {
  const pathEnv = context.pathEnv ? `${context.pathEnv}:${SYSTEM_PATH}` : SYSTEM_PATH;
  const waitForExit = `while kill -0 ${context.pid} 2>/dev/null; do sleep 0.25; done`;
  const macAppBundle = context.platform === "darwin" ? bundle ?? findMacAppBundle(context.execPath) : null;

  if (macAppBundle) {
    return {
      cmd: ["/bin/sh", "-c", `${waitForExit}; sleep 0.5; /usr/bin/open ${shellQuote(macAppBundle)}`],
      cwd: "/",
      pathEnv,
    };
  }

  const args = context.args.map(shellQuote).join(" ");
  return {
    cmd: ["/bin/sh", "-c", `${waitForExit}; cd ${shellQuote(context.cwd)} 2>/dev/null; ${shellQuote(context.execPath)}${args ? ` ${args}` : ""}`],
    cwd: "/",
    pathEnv,
  };
}

export interface WindowsRelaunch {
  /** The app's process, which the script waits out. */
  pid: number;
  /** `bin\launcher.exe` beside the runtime: what the Start menu opens. */
  launcher: string;
  log: string;
  cancel: string;
  taskName: string;
  /** GLOOMBERB_HOME for the app it opens; a task has the user's environment, not the app's. */
  home?: string;
}

/**
 * The PowerShell 5.1 script that opens the Windows app again. It answers
 * `started` in its log, waits for the app's process to be gone (Chromium's
 * profile stays held until then, and an app opened before hands itself to the
 * closing one and crashes), then opens the launcher. An app that stopped
 * waiting for it writes `cancel` and stays open, so the script opens nothing.
 */
export function windowsRelaunchScript({ pid, launcher, log, cancel, taskName, home }: WindowsRelaunch): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$OldPid = ${pid}`,
    `$Launcher = ${psString(launcher)}`,
    `$Log = ${psString(log)}`,
    `$Cancel = ${psString(cancel)}`,
    `$TaskName = ${psString(taskName)}`,
    `$DataHome = ${psString(home ?? "")}`,
    String.raw`
$LogEncoding = New-Object System.Text.UTF8Encoding $false
function Write-Log([string]$Message) {
  for ($Attempt = 0; $Attempt -lt 10; $Attempt += 1) {
    try { [IO.File]::AppendAllText($Log, (Get-Date).ToString('o') + ' ' + $Message + [Environment]::NewLine, $LogEncoding); return } catch { Start-Sleep -Milliseconds 100 }
  }
}

try {
  if (-not (Test-Path -LiteralPath $Launcher)) { Write-Log ('declined: no ' + $Launcher); return }
  Write-Log ('started ' + $PID)
  $Deadline = (Get-Date).AddMinutes(5)
  while ((Get-Process -Id $OldPid -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $Cancel) -and (Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $Cancel) { Write-Log 'the app stopped waiting; it stays open'; return }
  if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) { Write-Log 'the app did not quit'; return }
  Start-Sleep -Milliseconds 500
  if ($DataHome) { $env:GLOOMBERB_HOME = $DataHome }
  Start-Process -FilePath $Launcher -WorkingDirectory (Split-Path -Parent $Launcher)
  Write-Log ('opened ' + $Launcher)
} catch {
  Write-Log ('could not open the app: ' + $_.Exception.Message)
} finally {
  $ErrorActionPreference = 'Continue'
  schtasks.exe /delete /tn $TaskName /f | Out-Null
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`,
  ].join("\n");
}

/**
 * How long a restart waits for its script, with the error screen saying the
 * restart was asked. Windows PowerShell started by the Task Scheduler can take
 * over 20 s to run its first line: 23 s on an idle Windows on Arm machine,
 * over a minute on a busy one, where a task runs below normal priority.
 */
const RESTART_SCRIPT_START_TIMEOUT_MS = 120_000;

/**
 * Electrobun puts the Windows app in a job that ends every process it starts
 * when it exits, so the script runs from a scheduled task, which outlives it.
 * Resolves once the script has started: the app may quit then.
 */
async function scheduleWindowsRelaunch(context: RelaunchContext): Promise<void> {
  const name = `gloom-restart-${context.pid}`;
  const script = win32.join(tmpdir(), `${name}.ps1`);
  const log = win32.join(tmpdir(), `${name}.log`);
  const cancel = win32.join(tmpdir(), `${name}.cancel`);
  await rm(log, { force: true });
  await rm(cancel, { force: true });
  await writePowerShellScript(script, windowsRelaunchScript({
    pid: context.pid,
    launcher: win32.join(win32.dirname(context.execPath), "launcher.exe"),
    log,
    cancel,
    taskName: `GloomRestart-${context.pid}`,
    home: context.home,
  }));
  const answer = await runScriptAfterExit(script, log, cancel, `GloomRestart-${context.pid}`, RESTART_SCRIPT_START_TIMEOUT_MS);
  if (answer.kind !== "started") throw new Error(`the restart script did not start: ${answer.reason}`);
}

/**
 * Opens the app again once this process has exited. On a Mac, `bundle` opens
 * that bundle instead of the one this process runs from: the app's own, under
 * the name it was just given. Resolves once this process may exit.
 */
export async function scheduleDesktopRelaunch(bundle?: string, context: RelaunchContext = currentProcess()): Promise<void> {
  if (context.platform === "win32") {
    await scheduleWindowsRelaunch(context);
    return;
  }
  const { cmd, cwd, pathEnv } = desktopRelaunchCommand(context, bundle);
  const child = Bun.spawn(cmd, {
    ...(cwd ? { cwd } : {}),
    ...(pathEnv ? { env: { ...process.env, PATH: pathEnv } } : {}),
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
}
