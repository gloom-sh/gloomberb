import { writeRendererRaw } from "../../components/chart/native/kitty/adapter";
import { getNativeSurfaceManager } from "../../components/chart/native/surface/manager";
import type { NativeRendererHost } from "../../ui";

const ESC = 0x1b;
const ST_SLASH = 0x5c;

export interface TerminalMpvPlaybackOptions {
  url: string;
  cols: number;
  rows: number;
  left: number;
  top: number;
  pixelWidth: number;
  pixelHeight: number;
  muted?: boolean;
  renderer: NativeRendererHost;
  onPlaying?: () => void;
  onError?: (message: string) => void;
}

function findCsiEnd(buffer: Uint8Array, start: number): number {
  for (let index = start; index < buffer.length; index += 1) {
    const byte = buffer[index]!;
    if (byte >= 0x40 && byte <= 0x7e) return index;
  }
  return -1;
}

function findKittyEnd(buffer: Uint8Array, start: number): number {
  for (let index = start; index + 1 < buffer.length; index += 1) {
    if (buffer[index] === ESC && buffer[index + 1] === ST_SLASH) return index + 2;
  }
  return -1;
}

export function startTerminalMpvPlayback(options: TerminalMpvPlaybackOptions): () => void {
  const mpv = Bun.which("mpv");
  if (!mpv) {
    options.onError?.("mpv is required for terminal TV playback. Install mpv and try again.");
    return () => {};
  }

  const cols = Math.max(1, options.cols);
  const rows = Math.max(1, options.rows);
  const left = Math.max(1, options.left);
  const top = Math.max(1, options.top);
  const pixelWidth = Math.max(1, options.pixelWidth);
  const pixelHeight = Math.max(1, options.pixelHeight);

  const proc = Bun.spawn([
    mpv,
    "--no-config",
    "--profile=sw-fast",
    "--vo=kitty",
    "--vo-kitty-alt-screen=no",
    "--vo-kitty-config-clear=no",
    "--vo-kitty-auto-multiplexer-passthrough=no",
    "--vo-kitty-use-shm=no",
    "--really-quiet",
    "--osd-level=0",
    "--no-osc",
    "--no-terminal",
    "--input-terminal=no",
    "--input-vo-keyboard=no",
    "--keepaspect=no",
    `--vo-kitty-cols=${cols}`,
    `--vo-kitty-rows=${rows}`,
    `--vo-kitty-left=${left}`,
    `--vo-kitty-top=${top}`,
    `--vo-kitty-width=${pixelWidth}`,
    `--vo-kitty-height=${pixelHeight}`,
    "--cache=yes",
    "--demuxer-max-bytes=67108864",
    "--demuxer-readahead-secs=5",
    "--ytdl=no",
    `--mute=${options.muted === false ? "no" : "yes"}`,
    "--",
    options.url,
  ], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-kitty",
    },
  });

  let stopped = false;
  let pending = Buffer.alloc(0);
  let lastCup: Uint8Array | null = null;
  let sequences = 0;
  const saveRestorePrefix = Buffer.from("\x1b[s");
  const saveRestoreSuffix = Buffer.from("\x1b[u");

  const abort = () => {
    if (stopped) return;
    stopped = true;
    proc.kill();
  };

  const forwardKitty = (kitty: Uint8Array) => {
    sequences += 1;
    const parts = lastCup
      ? [saveRestorePrefix, lastCup, kitty, saveRestoreSuffix]
      : [saveRestorePrefix, kitty, saveRestoreSuffix];
    writeRendererRaw(options.renderer, Buffer.concat(parts));
    if (sequences === 1) options.onPlaying?.();
  };

  void (async () => {
    try {
      for await (const chunk of proc.stdout) {
        if (stopped) break;
        pending = Buffer.concat([pending, chunk]);
        let offset = 0;
        while (offset < pending.length) {
          if (pending[offset] !== ESC) {
            offset += 1;
            continue;
          }
          if (offset + 1 >= pending.length) break;
          const next = pending[offset + 1]!;
          if (next === 0x5b) {
            const end = findCsiEnd(pending, offset + 2);
            if (end < 0) break;
            const finalByte = pending[end]!;
            if (finalByte === 0x48 || finalByte === 0x66) {
              lastCup = Uint8Array.from(pending.subarray(offset, end + 1));
            }
            offset = end + 1;
            continue;
          }
          if (next === 0x5f && offset + 2 < pending.length && pending[offset + 2] === 0x47) {
            const end = findKittyEnd(pending, offset + 3);
            if (end < 0) break;
            forwardKitty(pending.subarray(offset, end));
            offset = end;
            continue;
          }
          offset += 1;
        }
        pending = pending.subarray(offset);
      }
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (!stopped && (exitCode !== 0 || sequences === 0)) {
        options.onError?.(stderr.trim().split("\n").slice(-3).join(" ") || `mpv exited with status ${exitCode}`);
      }
    } catch (cause) {
      if (!stopped) options.onError?.(cause instanceof Error ? cause.message : String(cause));
    }
  })();

  return () => {
    abort();
    writeRendererRaw(options.renderer, "\x1b_Ga=d,d=A\x1b\\");
    getNativeSurfaceManager(options.renderer).retransmitAll();
  };
}
