import { constants, watch, type FSWatcher } from "fs";
import { open, readFile, rm, stat } from "fs/promises";
import { basename, dirname } from "path";
import type { ProfileJson } from "../../profile-merge";
import { diffSharedConfig } from "./shared-layout";
import { debugLog } from "../../../utils/debug-log";

/**
 * config.json is shared: the app keeps it in memory and saves it as it goes,
 * while a `gloom` command run beside it (`alerts add`, `config set`,
 * `watchlist create`) reads, changes and writes it too. Each program that
 * writes the file goes through here, so neither undoes the other:
 *
 * - what this program last read from the file or wrote to it is kept, and a
 *   file that no longer reads so was changed by another program;
 * - that change is folded into whatever this program writes next, and handed
 *   to the program's listeners (the app folds it into its state);
 * - a write happens under a lock file, so two programs never read the same
 *   file and then each write over the other's change.
 *
 * A config object records how many of those changes it already holds (on a
 * symbol, which spreads copy and JSON leaves out). One built before the app
 * took a change in, a save still waiting on its timer, is written with that
 * change folded in, while one built after it is written as it is, so an edit
 * made in the app after taking the change in is never undone by it again.
 */

const log = debugLog.createLogger("config");

const CHANGES_HELD = Symbol.for("gloomberb.config.externalChangesHeld");

/** A lock older than this was left by a program that stopped mid-write. */
const LOCK_STALE_MS = 10_000;
/** A lock held longer than this is waited out no longer: the write goes ahead. */
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 15;
/** How soon a change event is read, so one write's several events read once. */
const CHECK_DELAY_MS = 50;
/** How often the file is looked at besides its change events, which some disks never send. */
const POLL_MS = 3_000;

export interface SharedFileChange {
  /** The change's place among the ones found: a config holding it has a count past this. */
  readonly index: number;
  readonly apply: ReturnType<typeof diffSharedConfig>["apply"];
}

interface SharedFileState {
  /** The file as this program last read or wrote it; null before either. */
  known: string | null;
  /** The changes other programs made, in the order they were found. */
  readonly changes: SharedFileChange[];
  readonly listeners: Set<(change: SharedFileChange) => void>;
  /** The save in flight or queued last; it never rejects. */
  queue: Promise<void>;
  stopWatching: (() => void) | null;
}

const states = new Map<string, SharedFileState>();

function stateFor(path: string): SharedFileState {
  let state = states.get(path);
  if (!state) {
    state = { known: null, changes: [], listeners: new Set(), queue: Promise.resolve(), stopWatching: null };
    states.set(path, state);
  }
  return state;
}

/**
 * How many of the file's changes `value` holds: those found before it was
 * read or took them in. A value that does not say (built from scratch, or
 * passed through a structured clone) counts as holding `unmarked`, every
 * change found so far unless the caller knows better.
 */
export function changesHeld(path: string, value: object, unmarked = stateFor(path).changes.length): number {
  const held = (value as Record<symbol, unknown>)[CHANGES_HELD];
  return typeof held === "number" ? held : unmarked;
}

/** Marks `value` as holding every change found so far, or the first `count`. */
export function markChangesHeld<T extends object>(path: string, value: T, count = stateFor(path).changes.length): T {
  (value as Record<symbol, unknown>)[CHANGES_HELD] = count;
  return value;
}

/** The file was read: its first read is what later reads and writes are compared with. */
export function noteSharedFileRead(path: string, contents: string): void {
  const state = stateFor(path);
  if (state.known === null) state.known = contents;
}

/** The file is gone (a reset): the next write starts over. */
export function forgetSharedFile(path: string): void {
  stateFor(path).known = null;
}

/** The changes found after the first `held`, to fold into a copy built before them. */
export function changesSince(path: string, held: number): SharedFileChange[] {
  return stateFor(path).changes.slice(held);
}

function parse(contents: string): ProfileJson | undefined {
  try {
    return JSON.parse(contents) as ProfileJson;
  } catch {
    // Intentional ignore: a file that does not parse has nothing to merge; it is written over as before.
    return undefined;
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Compares the file with what this program knows of it, and records what another program changed. */
function noteContents(path: string, state: SharedFileState, contents: string | null): void {
  if (contents === null || contents === state.known) return;
  const known = state.known;
  state.known = contents;
  if (known === null) return;
  const before = parse(known);
  const after = parse(contents);
  if (before === undefined || after === undefined) return;
  const delta = diffSharedConfig(before, after);
  if (delta.count === 0) return;
  const change: SharedFileChange = { index: state.changes.length, apply: delta.apply };
  state.changes.push(change);
  log.info("config.changed.elsewhere", { edits: delta.count });
  for (const listener of state.listeners) {
    try {
      listener(change);
    } catch (error) {
      log.warn("config.change.listener.failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function enqueue(state: SharedFileState, job: () => Promise<void>): Promise<void> {
  const result = state.queue.then(job);
  state.queue = result.catch(() => { /* Intentional ignore: the caller receives result; the chain only keeps later jobs running. */ });
  return result;
}

/**
 * Writes `contents` (this program's copy, holding the first `held` changes)
 * with every change it lacks folded in, including one found just now. Writes
 * to one file run one after another in call order.
 */
export function writeSharedFile(
  path: string,
  contents: string,
  held: number,
  write: (contents: string) => Promise<void>,
): Promise<void> {
  const state = stateFor(path);
  return enqueue(state, () => withFileLock(path, async () => {
    noteContents(path, state, await readIfPresent(path));
    const output = foldChanges(contents, state.changes.slice(held));
    await write(output);
    state.known = output;
  }));
}

function foldChanges(contents: string, changes: readonly SharedFileChange[]): string {
  if (changes.length === 0) return contents;
  const mine = parse(contents);
  if (mine === undefined) return contents;
  let merged = mine;
  for (const change of changes) merged = change.apply(merged);
  return merged === mine ? contents : JSON.stringify(merged, null, 2);
}

/** Reads the file now and hands any change another program made to the listeners. */
function checkSharedFile(path: string): Promise<void> {
  const state = stateFor(path);
  return enqueue(state, async () => {
    noteContents(path, state, await readIfPresent(path));
  });
}

/**
 * Calls `listener` with each change another program makes to the file,
 * found by watching it, or at the latest when this program next writes it.
 * A listener runs before anything else is written, and must fold the change
 * into this program's copy before it returns.
 */
export function watchSharedFile(path: string, listener: (change: SharedFileChange) => void): () => void {
  const state = stateFor(path);
  state.listeners.add(listener);
  if (!state.stopWatching) state.stopWatching = startWatching(path);
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0 && state.stopWatching) {
      state.stopWatching();
      state.stopWatching = null;
    }
  };
}

function startWatching(path: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSeen: string | null = null;
  const check = () => {
    timer = null;
    checkSharedFile(path).catch((error: unknown) => {
      log.warn("config.check.failed", { error: error instanceof Error ? error.message : String(error) });
    });
  };
  const soon = () => {
    if (timer) return;
    timer = setTimeout(check, CHECK_DELAY_MS);
    timer.unref?.();
  };
  let watcher: FSWatcher | null = null;
  try {
    // The folder, not the file: a save replaces the file, and a watch on the old one would see nothing after.
    // Some systems name only the temporary file a save renames into place (config.json.<n>.tmp).
    const name = basename(path);
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      const changed = filename?.toString();
      if (!changed || changed === name || changed.startsWith(`${name}.`)) soon();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    // Intentional ignore: without change events the poll below still finds a change.
    watcher = null;
  }
  const poll = setInterval(() => {
    void stat(path).then((info) => {
      const seen = `${info.mtimeMs}:${info.size}`;
      if (lastSeen !== null && seen !== lastSeen) soon();
      lastSeen = seen;
    }, () => { /* Intentional ignore: a missing file is checked again on the next tick. */ });
  }, POLL_MS);
  poll.unref?.();
  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}

/**
 * Runs `task` holding `<path>.lock`, which every program writing the file
 * takes, so none reads the file while another is between its own read and
 * write. A lock left by a program that stopped is taken over once stale, and
 * one held too long is not waited on: a save never hangs on a lock.
 */
async function withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(token, "utf-8");
      } finally {
        await handle.close();
      }
      held = true;
      break;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // No folder yet, or one that refuses the lock: the write goes ahead and reports its own failure.
      if (code !== "EEXIST") break;
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => { /* Intentional ignore: another program may have taken it over first. */ });
        continue;
      }
      if (Date.now() >= deadline) {
        log.warn("config.lock.busy", { lockPath });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await task();
  } finally {
    if (held) await releaseLock(lockPath, token);
  }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Intentional ignore: a lock gone meanwhile is free; the next try takes it.
    return false;
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if (await readFile(lockPath, "utf-8") === token) await rm(lockPath, { force: true });
  } catch {
    // Intentional ignore: a lock already gone, or taken over as stale, is not this write's to remove.
  }
}
