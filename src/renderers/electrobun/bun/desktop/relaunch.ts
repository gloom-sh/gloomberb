import { dirname } from "path";

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

function spawnDetached(command: string[]): void {
  const child = Bun.spawn(command, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  } as any);
  child.unref();
}

/**
 * Opens the app again once this process has exited. On a Mac, `bundle` opens
 * that bundle instead of the one this process runs from: the app's own, under
 * the name it was just given.
 */
export function scheduleDesktopRelaunch(bundle?: string): void {
  const pid = process.pid;
  const macAppBundle = process.platform === "darwin" ? bundle ?? findMacAppBundle(process.execPath) : null;

  if (macAppBundle) {
    spawnDetached([
      "sh",
      "-c",
      `while kill -0 ${pid} 2>/dev/null; do sleep 0.25; done; sleep 0.5; open ${shellQuote(macAppBundle)}`,
    ]);
    return;
  }

  if (process.platform === "win32") {
    spawnDetached([process.execPath, ...process.argv.slice(1)]);
    return;
  }

  const args = process.argv.slice(1).map(shellQuote).join(" ");
  spawnDetached([
    "sh",
    "-c",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.25; done; cd ${shellQuote(process.cwd())}; ${shellQuote(process.execPath)}${args ? ` ${args}` : ""}`,
  ]);
}
