import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTerminalMediaArgs, createTerminalMediaReaper, type TerminalMediaChild } from "./terminal-media";

const dirs: string[] = [];

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "gloom-media-"));
  dirs.push(dir);
  return join(dir, "terminal-media.pid");
}

function fakeChild(pid: number): TerminalMediaChild & { killed: boolean; exit(): void } {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  return {
    pid,
    killed: false,
    kill() { this.killed = true; },
    exited,
    exit() { resolveExit(0); },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("kills the player left behind by a run that was killed without warning", () => {
  const file = stateFile();
  writeFileSync(file, "4242", "utf8");
  const killed: number[] = [];
  const reaper = createTerminalMediaReaper({
    stateFile: file,
    isPlayerProcess: (pid) => pid === 4242,
    killProcess: (pid) => killed.push(pid),
    installExitHooks: false,
  });

  reaper.reapStale();

  expect(killed).toEqual([4242]);
  // The pid must not linger, or a later run kills whatever inherits it.
  expect(existsSync(file)).toBe(false);
});

test("leaves a recycled pid alone when it is not our player", () => {
  const file = stateFile();
  writeFileSync(file, "4242", "utf8");
  const killed: number[] = [];
  const reaper = createTerminalMediaReaper({
    stateFile: file,
    isPlayerProcess: () => false,
    killProcess: (pid) => killed.push(pid),
    installExitHooks: false,
  });

  reaper.reapStale();

  expect(killed).toEqual([]);
});

test("replacing a player kills the previous one and records the new pid", () => {
  const file = stateFile();
  const reaper = createTerminalMediaReaper({
    stateFile: file,
    isPlayerProcess: () => false,
    killProcess: () => {},
    installExitHooks: false,
  });

  const first = fakeChild(11);
  const second = fakeChild(22);
  reaper.track(first);
  expect(readFileSync(file, "utf8")).toBe("11");

  reaper.track(second);

  expect(first.killed).toBe(true);
  expect(second.killed).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("22");
});

test("caps the stream the terminal has to decode and draw", () => {
  const args = buildTerminalMediaArgs({ url: "https://example.com/live.m3u8", platform: "darwin" });

  // Without a cap mpv takes the top rendition, so a text grid costs a 1080p60 decode.
  expect(args).toContain("--hls-bitrate=1500000");
  expect(args).toContain("--vf=fps=15");
  // The probe stays generous: YouTube's HLS needs it to expose its streams at all.
  expect(args).toContain("--demuxer-lavf-probesize=25000000");
});

test("offers the copy-back decoder only where it exists", () => {
  const base = { url: "https://example.com/live.m3u8" };

  expect(buildTerminalMediaArgs({ ...base, platform: "darwin" })).toContain("--hwdec=videotoolbox-copy");
  expect(buildTerminalMediaArgs({ ...base, platform: "linux" }).join(" ")).not.toContain("--hwdec");
});

test("keeps the url last and behind a separator so it is never read as an option", () => {
  const args = buildTerminalMediaArgs({ url: "-not-an-option.m3u8", title: "CNBC", muted: false, platform: "linux" });

  expect(args.slice(-2)).toEqual(["--", "-not-an-option.m3u8"]);
  expect(args).toContain("--mute=no");
  expect(args).toContain("--title=CNBC");
});

test("a player that exits on its own clears the recorded pid", async () => {
  const file = stateFile();
  const reaper = createTerminalMediaReaper({
    stateFile: file,
    isPlayerProcess: () => false,
    killProcess: () => {},
    installExitHooks: false,
  });

  const child = fakeChild(33);
  reaper.track(child);
  child.exit();
  await child.exited;
  await Promise.resolve();

  expect(existsSync(file)).toBe(false);
});
