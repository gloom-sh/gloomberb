import { logFailure } from "../../../utils/log-failure";
import type { NoteOwner, NotesStore } from "./store";

export interface QuickNoteEntry {
  id: string;
  title: string;
  updatedAt?: number;
}

/** A stored note: `key` is what `load`/`save` take, not the file path. */
export interface NoteFileEntry {
  key: string;
  text: string;
  updatedAt: number;
}

/**
 * Where `NotesFiles` keeps its files, by name inside its data directory. Bun
 * reads the disk, a browser keeps them in localStorage, and the desktop view
 * asks its Bun process, which serves the disk one.
 */
export interface NotesFilesIO {
  /** The file's text, or null when it was never written. Any other failure rejects. */
  read(file: string): Promise<string | null>;
  write(file: string, text: string): Promise<void>;
  /** A file that is already gone is not an error. */
  delete(file: string): Promise<void>;
  /**
   * Every note's key (its `.md` file name without the extension) and when it
   * was last written. A folder that does not exist yet, or a note gone before
   * it was looked at, lists nothing. Any other failure is logged and that part
   * left out, or, with `strict`, rejects.
   */
  listKeys(options?: { strict?: boolean }): Promise<Array<[string, number]>>;
}

const QUICK_NOTES_INDEX_FILE = "__quick-notes-index__.json";

export interface NotesListOptions {
  /** A notes folder that cannot be listed rejects instead of listing nothing. */
  strict?: boolean;
  /** Hears each note left out because it could not be read, for a caller that says so. */
  skipped?: (key: string, error: unknown) => void;
}
const LOCAL_KEY_PREFIX = "gloomberb:notes:";
const LOCAL_TIMESTAMP_KEY = "gloomberb:notes:__updated-at__";

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** The only files `NotesFiles` touches; a host serving its IO refuses anything else. */
export function isNotesFile(file: string): boolean {
  return file === QUICK_NOTES_INDEX_FILE || file.endsWith(".md");
}

async function nodeFs(): Promise<typeof import("fs/promises")> {
  const fsModulePath = "fs/promises";
  return await import(fsModulePath) as typeof import("fs/promises");
}

/** The files on disk: what the terminal reads, and what the desktop's Bun process serves its view. */
export function diskNotesFilesIO(dataDir: string): NotesFilesIO {
  const pathOf = (file: string) => joinPath(dataDir, file);
  return {
    async read(file) {
      const { readFile } = await nodeFs();
      try {
        return await readFile(pathOf(file), "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(file, text) {
      const { mkdir, writeFile } = await nodeFs();
      const path = pathOf(file);
      // The folder the file sits in, which is below dataDir when a symbol has a "/".
      await mkdir(path.slice(0, path.lastIndexOf("/")) || dataDir, { recursive: true });
      await writeFile(path, text, "utf-8");
    },
    async delete(file) {
      const { unlink } = await nodeFs();
      try {
        await unlink(pathOf(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async listKeys(options) {
      const { readdir, stat } = await nodeFs();
      let names: string[];
      try {
        names = await readdir(dataDir);
      } catch (error) {
        // A data directory that was never created holds no notes yet.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        if (options?.strict) throw error;
        logFailure("notes.files", "List the notes folder failed")(error);
        return [];
      }
      const keys: Array<[string, number]> = [];
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        try {
          const info = await stat(pathOf(name));
          keys.push([name.slice(0, -3), Math.round(info.mtimeMs)]);
        } catch (error) {
          // A note deleted since the folder was listed is simply gone.
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          if (options?.strict) throw error;
          logFailure("notes.files", "Read when a note was last written failed")(error);
        }
      }
      return keys;
    },
  };
}

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getLocalStorage(): LocalStorageLike | null {
  return (globalThis as { localStorage?: LocalStorageLike }).localStorage ?? null;
}

/** Browsers have no mtime, so note writes keep their own timestamp index. */
function readLocalTimestamps(): Record<string, number> {
  try {
    const raw = getLocalStorage()?.getItem(LOCAL_TIMESTAMP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, number>
      : {};
  } catch (error) {
    return logFailure("notes.files", "Read the browser note timestamp index failed", {})(error);
  }
}

function writeLocalTimestamp(path: string, updatedAt: number | null): void {
  const storage = getLocalStorage();
  if (!storage) return;
  const timestamps = readLocalTimestamps();
  if (updatedAt == null) delete timestamps[path];
  else timestamps[path] = updatedAt;
  try {
    storage.setItem(LOCAL_TIMESTAMP_KEY, JSON.stringify(timestamps));
  } catch (error) {
    logFailure("notes.files", "Save the browser note timestamp index failed")(error);
  }
}

function localStorageNotesFilesIO(dataDir: string): NotesFilesIO {
  const pathOf = (file: string) => joinPath(dataDir, file);
  return {
    async read(file) {
      return getLocalStorage()?.getItem(`${LOCAL_KEY_PREFIX}${pathOf(file)}`) ?? null;
    },
    async write(file, text) {
      getLocalStorage()?.setItem(`${LOCAL_KEY_PREFIX}${pathOf(file)}`, text);
      writeLocalTimestamp(pathOf(file), Date.now());
    },
    async delete(file) {
      getLocalStorage()?.removeItem(`${LOCAL_KEY_PREFIX}${pathOf(file)}`);
      writeLocalTimestamp(pathOf(file), null);
    },
    // Nothing here can leave a note out: notes missing from the timestamp
    // index are stamped from what localStorage holds, so `strict` changes nothing.
    async listKeys() {
      const prefix = joinPath(dataDir, "");
      const timestamps = readLocalTimestamps();
      const storageKeyPrefix = `${LOCAL_KEY_PREFIX}${prefix}`;
      // Notes written before the index existed are stamped now rather than at
      // the epoch, so an older cloud copy cannot overwrite them on first sync.
      for (const storageKey of Object.keys(globalThis.localStorage ?? {})) {
        if (!storageKey.startsWith(storageKeyPrefix) || !storageKey.endsWith(".md")) continue;
        const path = storageKey.slice(LOCAL_KEY_PREFIX.length);
        if (timestamps[path] == null) writeLocalTimestamp(path, timestamps[path] = Date.now());
      }
      return Object.entries(timestamps)
        .filter(([path]) => path.startsWith(prefix) && path.endsWith(".md"))
        .map(([path, updatedAt]) => [path.slice(prefix.length, -3), updatedAt]);
    },
  };
}

/**
 * An IO whose calls run elsewhere under the same names, with the data
 * directory added to each payload. The desktop view sends them to the Bun
 * process's notes-files capability.
 */
export function remoteNotesFilesIO(
  dataDir: string,
  invoke: (operationId: keyof NotesFilesIO, payload: Record<string, unknown>) => Promise<unknown>,
): NotesFilesIO {
  return {
    read: async (file) => await invoke("read", { dataDir, file }) as string | null,
    write: async (file, text) => { await invoke("write", { dataDir, file, text }); },
    delete: async (file) => { await invoke("delete", { dataDir, file }); },
    listKeys: async (options) => await invoke("listKeys", { dataDir, ...(options?.strict ? { strict: true } : {}) }) as Array<[string, number]>,
  };
}

let hostNotesFilesIO: ((dataDir: string) => NotesFilesIO) | null = null;

/**
 * A renderer that cannot reach the files itself installs how to at startup,
 * the way the desktop view goes through its Bun process. The others read the
 * disk under Bun and localStorage in a browser.
 */
export function setNotesFilesIO(factory: ((dataDir: string) => NotesFilesIO) | null): void {
  hostNotesFilesIO = factory;
}

function defaultNotesFilesIO(dataDir: string): NotesFilesIO {
  if (hostNotesFilesIO) return hostNotesFilesIO(dataDir);
  return typeof Bun !== "undefined" ? diskNotesFilesIO(dataDir) : localStorageNotesFilesIO(dataDir);
}

export class NotesFiles implements NotesStore {
  readonly readOnly = false;
  readonly owner: NoteOwner = { kind: "user" };

  constructor(dataDir: string, private readonly io: NotesFilesIO = defaultNotesFilesIO(dataDir)) {}

  /**
   * A note that was never written is empty, but any other read failure is
   * rethrown: an unreadable note must not present itself as an empty editable
   * one, or the next save silently overwrites real content.
   */
  async load(symbol: string): Promise<string> {
    return (await this.io.read(`${symbol}.md`)) ?? "";
  }

  async save(symbol: string, notes: string): Promise<void> {
    await this.io.write(`${symbol}.md`, notes || "");
  }

  async delete(symbol: string): Promise<void> {
    await this.io.delete(`${symbol}.md`);
  }

  /** Every stored note, ticker notes and quick notes alike, newest first. */
  async list(options: NotesListOptions = {}): Promise<NoteFileEntry[]> {
    const { entries } = await this.readEach(await this.io.listKeys({ strict: options.strict }), options.skipped);
    return entries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * The quick notes' ids and titles. An index never written is empty; one that
   * cannot be read or parsed is logged and read as empty, or, with `strict`,
   * rejects, so the caller cannot mistake it for none.
   */
  async loadQuickNotesIndex(options: { strict?: boolean } = {}): Promise<QuickNoteEntry[]> {
    try {
      const raw = await this.io.read(QUICK_NOTES_INDEX_FILE);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      if (options.strict) throw error;
      return logFailure("notes.files", "Read the quick notes index failed", [])(error);
    }
  }

  async saveQuickNotesIndex(entries: QuickNoteEntry[]): Promise<void> {
    await this.io.write(QUICK_NOTES_INDEX_FILE, JSON.stringify(entries));
  }

  quickNoteKey(id: string): string {
    return `__note-${id}__`;
  }

  /**
   * The notes the move to Cloud uploads: every note that can be read, and how
   * many cannot. Unlike `list`, a folder that cannot be read rejects, so the
   * move never mistakes a failed read for having no notes.
   */
  async listForMove(): Promise<{ entries: NoteFileEntry[]; unreadable: number }> {
    const listed = await this.readEach(await this.io.listKeys({ strict: true }));
    listed.entries.sort((left, right) => right.updatedAt - left.updatedAt);
    return listed;
  }

  /** An unreadable note is left out and counted rather than synced as empty. */
  private async readEach(
    keys: Array<[string, number]>,
    skipped?: NotesListOptions["skipped"],
  ): Promise<{ entries: NoteFileEntry[]; unreadable: number }> {
    const entries: NoteFileEntry[] = [];
    let unreadable = 0;
    for (const [key, updatedAt] of keys) {
      try {
        entries.push({ key, text: await this.load(key), updatedAt });
      } catch (error) {
        unreadable += 1;
        logFailure("notes.files", "Read a note while listing notes failed")(error);
        skipped?.(key, error);
      }
    }
    return { entries, unreadable };
  }
}
