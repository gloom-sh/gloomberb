import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTerminalMediaReaper, type TerminalMediaChild } from "./terminal-media";

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
