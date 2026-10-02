import { join } from "path";
import { getGloomberbDirs } from "../../data/config/home";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";

/** The subset of `Bun.Subprocess` this module needs, so tests can supply a fake. */
export interface TerminalMediaChild {
  readonly pid: number;
  kill(): void;
  readonly exited: Promise<number>;
}

export interface TerminalMediaReaperOptions {
  /** File holding the pids of the players this and earlier runs started. */
  stateFile: string;
  /** True when the pid is one of our players and its parent is gone. */
  isStrandedPlayer?(pid: number): boolean;
  killProcess?(pid: number): void;
  /** Install process exit hooks. Off in tests so the suite keeps its handlers. */
  installExitHooks?: boolean;
}

export interface TerminalMediaReaper {
  /** Kill players left behind by runs that are no longer around to do it. */
  reapStale(): void;
  /** Adopt a freshly spawned player, replacing and killing any current one. */
  track(child: TerminalMediaChild): void;
  /** Kill the player this run started, if it is still going. */
  stopActive(): void;
}

export function terminalMediaStateFile(): string {
  return join(getGloomberbDirs().data, "terminal-media.pid");
}

/**
 * Startup cleanup, for any renderer. Reaping used to happen only just before
 * starting a new terminal player, which meant a stranded one survived for as
 * long as nobody played TV in a terminal again. The desktop app is the likeliest
 * thing to be launched next, and it never plays terminal media, so leaving it
 * out is what let a player decode video for hours after its app was gone.
 */
export function reapStaleTerminalMedia(): void {
  createTerminalMediaReaper({
    stateFile: terminalMediaStateFile(),
    installExitHooks: false,
  }).reapStale();
}

export interface TerminalMediaArgsOptions {
  url: string;
  title?: string;
  muted?: boolean;
  /** Defaults to the running platform; injectable so the choice stays testable. */
  platform?: NodeJS.Platform;
}

/**
 * Best variant at or below this bitrate, roughly 480p on YouTube's live ladder.
 * A pane is a few hundred pixels wide, so the default (highest variant, often
 * 1080p60) decodes detail the terminal throws away.
 */
const HLS_BITRATE_CAP = 1_500_000;

/**
 * What is deliberately not capped here: the size and rate of the frames sent to
 * the terminal. `vo=kitty` scales every frame to the terminal's own pixel size,
 * base64s it and writes it to the tty, and it re-reads that size on every frame
 * so that resizing adapts live. Pinning `--vo-kitty-width/height` would buy back
 * that bandwidth but freeze the picture at a fixed rectangle, because the
 * transmit escape carries no cell-placement keys for the terminal to scale it
 * back up. Capping the frame rate is no better: the selected rendition runs at
 * 30, so the only cap that divides evenly is 15, and the rest judder.
 *
 * `--vo-kitty-use-shm=yes` is the option that would cut the tty traffic without
 * costing picture, but it depends on the terminal supporting shared-memory
 * transfer, so it wants testing against a real terminal before it goes in.
 */

/**
 * `vo=kitty` is a software path from decode to tty write, and it is paid three
 * times over: by the player, by tmux, and by the terminal emulator. These options
 * keep the work proportional to what a text grid can actually display.
 */
export function buildTerminalMediaArgs(options: TerminalMediaArgsOptions): string[] {
  const { url, title, muted, platform = process.platform } = options;
  return [
    "--no-config",
    "--profile=sw-fast",
    "--vo=kitty",
    "--vo-kitty-auto-multiplexer-passthrough=yes",
    // YouTube's HLS needs a generous probe before it exposes its streams.
    "--demuxer-lavf-probe-info=yes",
    "--demuxer-lavf-analyzeduration=10",
    "--demuxer-lavf-probesize=25000000",
    `--hls-bitrate=${HLS_BITRATE_CAP}`,
    // The kitty output reads frames from system memory, so only a copy-back
    // decoder helps here. An unavailable one degrades to software decoding.
    ...(platform === "darwin" ? ["--hwdec=videotoolbox-copy"] : []),
    "--ytdl=no",
    `--mute=${muted === false ? "no" : "yes"}`,
    ...(title ? [`--title=${title}`] : []),
    "--",
    url,
  ];
}

function defaultIsStrandedPlayer(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    // A recycled pid could belong to anything, so confirm the command first.
    const probe = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm=,ppid="]);
    if (probe.exitCode !== 0) return false;
    const line = probe.stdout.toString().trim();
    if (!line.toLowerCase().includes("mpv")) return false;
    // Only a player whose parent is gone may be killed. A live instance still
    // owns its own player, and reaping runs on startup now, so a second window
    // must never be able to shoot down the first one's playback.
    return Number.parseInt(line.slice(line.lastIndexOf(" ") + 1), 10) === 1;
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
 * Recording the pids on disk lets a later run kill those players even though the
 * run that started them was killed without warning. Every pid is kept, not just
 * the most recent, because a watch loop can strand one player per reload.
 */
export function createTerminalMediaReaper(options: TerminalMediaReaperOptions): TerminalMediaReaper {
  const {
    stateFile,
    isStrandedPlayer = defaultIsStrandedPlayer,
    killProcess = defaultKillProcess,
    installExitHooks = true,
  } = options;

  let active: TerminalMediaChild | null = null;
  let hooksInstalled = false;

  function readPids(): number[] {
    try {
      if (!existsSync(stateFile)) return [];
      return readFileSync(stateFile, "utf8")
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 1);
    } catch {
      return [];
    }
  }

  function writePids(pids: number[]): void {
    try {
      if (!pids.length) {
        rmSync(stateFile, { force: true });
        return;
      }
      writeFileSync(stateFile, `${pids.join("\n")}\n`, "utf8");
    } catch {
      // Losing a pid only costs us cross-restart reaping, never correctness.
    }
  }

  function forgetState(pid?: number): void {
    writePids(pid === undefined ? [] : readPids().filter((item) => item !== pid));
  }

  function rememberState(pid: number): void {
    writePids([...readPids().filter((item) => item !== pid), pid]);
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
      forgetState(child.pid);
    }
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
      const survivors: number[] = [];
      for (const pid of readPids()) {
        if (pid === active?.pid) {
          survivors.push(pid);
        } else if (isStrandedPlayer(pid)) {
          killProcess(pid);
        }
      }
      writePids(survivors);
    },
    track(child) {
      stopActive();
      active = child;
      rememberState(child.pid);
      installExitCleanup();
      void child.exited.then(() => {
        if (active === child) active = null;
        forgetState(child.pid);
      }).catch(() => {});
    },
    stopActive,
  };
}
