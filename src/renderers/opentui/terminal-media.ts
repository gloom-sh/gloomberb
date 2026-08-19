import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";

/** The subset of `Bun.Subprocess` this module needs, so tests can supply a fake. */
export interface TerminalMediaChild {
  readonly pid: number;
  kill(): void;
  readonly exited: Promise<number>;
}

export interface TerminalMediaReaperOptions {
  /** File holding the pid of the player started by the most recent run. */
  stateFile: string;
  /** True when the pid is still running and is actually our media player. */
  isPlayerProcess?(pid: number): boolean;
  killProcess?(pid: number): void;
  /** Install process exit hooks. Off in tests so the suite keeps its handlers. */
  installExitHooks?: boolean;
}

export interface TerminalMediaReaper {
  /** Kill a player left behind by a previous run of the app. */
  reapStale(): void;
  /** Adopt a freshly spawned player, replacing and killing any current one. */
  track(child: TerminalMediaChild): void;
  /** Kill the player this run started, if it is still going. */
  stopActive(): void;
}

export function terminalMediaStateFile(): string {
  return join(process.env.HOME || homedir(), ".gloomberb", "terminal-media.pid");
}

function defaultIsPlayerProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    // A recycled pid could belong to anything, so confirm the command first.
    const probe = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]);
    if (probe.exitCode !== 0) return false;
    return probe.stdout.toString().toLowerCase().includes("mpv");
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone, or not ours to kill.
  }
}

/**
 * `mpv` outlives the app: it is a plain child process, and `bun run --watch`
 * restarts by SIGKILLing the parent, so no exit handler ever runs. Every reload
 * with the TV pane open used to strand another player decoding video forever.
 *
 * Recording the pid on disk lets the next run kill the previous player even
 * though that run was killed without warning.
 */
export function createTerminalMediaReaper(options: TerminalMediaReaperOptions): TerminalMediaReaper {
  const {
    stateFile,
    isPlayerProcess = defaultIsPlayerProcess,
    killProcess = defaultKillProcess,
    installExitHooks = true,
  } = options;

  let active: TerminalMediaChild | null = null;
  let hooksInstalled = false;

  function forgetState(): void {
    try {
      rmSync(stateFile, { force: true });
    } catch {
      // A stale pid file is harmless; the next reap validates it anyway.
    }
  }

  function rememberState(pid: number): void {
    try {
      writeFileSync(stateFile, String(pid), "utf8");
    } catch {
      // Losing the pid only costs us cross-restart reaping, never correctness.
    }
  }

  function stopActive(): void {
    const child = active;
    active = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }
    forgetState();
  }

  function installExitCleanup(): void {
    if (hooksInstalled || !installExitHooks) return;
    hooksInstalled = true;
    // Covers orderly shutdown. A SIGKILLed parent is handled by reapStale.
    process.on("exit", stopActive);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        stopActive();
        process.exit(0);
      });
    }
  }

  return {
    reapStale() {
      if (!existsSync(stateFile)) return;
      let pid = 0;
      try {
        pid = Number.parseInt(readFileSync(stateFile, "utf8").trim(), 10);
      } catch {
        pid = 0;
      }
      forgetState();
      if (Number.isFinite(pid) && pid > 0 && isPlayerProcess(pid)) killProcess(pid);
    },
    track(child) {
      stopActive();
      active = child;
      rememberState(child.pid);
      installExitCleanup();
      void child.exited.then(() => {
        if (active === child) {
          active = null;
          forgetState();
        }
      }).catch(() => {});
    },
    stopActive,
  };
}
