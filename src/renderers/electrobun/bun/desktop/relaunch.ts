import { dirname, win32 } from "path";

/**
 * The folders the relaunch script finds `sleep` in, after whatever PATH the
 * app was started with: a terminal launch can hand it a PATH without them.
 */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A PowerShell command line for `script`, with no quoting left to get wrong. */
function hiddenPowershell(script: string): string[] {
  return [
    "powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ];
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
}

interface RelaunchCommand {
  cmd: string[];
  /** Where it starts; unset keeps this process's folder. */
  cwd?: string;
  /** PATH for it; unset keeps this process's. */
  pathEnv?: string;
  /**
   * It hands the relaunch on and exits, and this process may only exit after
   * it has: anything this process starts dies with it.
   */
  waitForIt?: boolean;
}

function currentProcess(): RelaunchContext {
  return {
    platform: process.platform,
    pid: process.pid,
    execPath: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    pathEnv: process.env.PATH ?? "",
  };
}

/**
 * What opens the app again once `context.pid` has exited. The script runs in
 * `/` with the shell and `open` named by their full paths: the launcher starts
 * the app inside its bundle's `Contents/MacOS`, which a rename to the app's
 * new name takes away, and a spawn into a folder that is gone fails as if the
 * shell were missing (`ENOENT, posix_spawn 'sh'`).
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

  if (context.platform === "win32") {
    // Chromium's profile stays held until this process has exited: an app
    // started before then hands itself to this one and crashes. It starts as
    // the Start menu starts it, from the launcher beside the runtime.
    const bin = win32.dirname(context.execPath);
    const launcher = win32.join(bin, "launcher.exe");
    const relaunch = hiddenPowershell(
      `Wait-Process -Id ${context.pid} -ErrorAction SilentlyContinue; Start-Process -FilePath ${powershellQuote(launcher)} -WorkingDirectory ${powershellQuote(bin)}`,
    ).join(" ");
    // Electrobun puts this process in a job that ends every process it starts
    // when it exits, so the waiting is done by a process Windows starts for it.
    return {
      cmd: hiddenPowershell([
        "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
        `$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellQuote(relaunch)}; CurrentDirectory = ${powershellQuote(bin)}; ProcessStartupInformation = $startup }`,
        "exit $created.ReturnValue",
      ].join("; ")),
      waitForIt: true,
    };
  }

  const args = context.args.map(shellQuote).join(" ");
  return {
    cmd: ["/bin/sh", "-c", `${waitForExit}; cd ${shellQuote(context.cwd)} 2>/dev/null; ${shellQuote(context.execPath)}${args ? ` ${args}` : ""}`],
    cwd: "/",
    pathEnv,
  };
}

const HAND_OFF_TIMEOUT_MS = 20_000;

/**
 * Opens the app again once this process has exited. On a Mac, `bundle` opens
 * that bundle instead of the one this process runs from: the app's own, under
 * the name it was just given. Resolves once this process may exit.
 */
export async function scheduleDesktopRelaunch(bundle?: string, context: RelaunchContext = currentProcess()): Promise<void> {
  const { cmd, cwd, pathEnv, waitForIt } = desktopRelaunchCommand(context, bundle);
  const child = Bun.spawn(cmd, {
    ...(cwd ? { cwd } : {}),
    ...(pathEnv ? { env: { ...process.env, PATH: pathEnv } } : {}),
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (!waitForIt) {
    child.unref();
    return;
  }
  const code = await Promise.race([child.exited, Bun.sleep(HAND_OFF_TIMEOUT_MS).then(() => null)]);
  if (code !== 0) {
    child.kill();
    throw new Error(code === null ? "the relaunch was not handed on in time" : `the relaunch was not handed on (${code})`);
  }
}
