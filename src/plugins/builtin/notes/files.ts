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
  /** Every note's key (its `.md` file name without the extension) and when it was last written. */
  listKeys(): Promise<Array<[string, number]>>;
}

const QUICK_NOTES_INDEX_FILE = "__quick-notes-index__.json";
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
    async listKeys() {
      const { readdir, stat } = await nodeFs();
      let names: string[];
      try {
        names = await readdir(dataDir);
      } catch {
        return [];
      }
      const keys: Array<[string, number]> = [];
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        try {
          const info = await stat(pathOf(name));
          keys.push([name.slice(0, -3), Math.round(info.mtimeMs)]);
        } catch {}
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
  } catch {
    return {};
  }
}

function writeLocalTimestamp(path: string, updatedAt: number | null): void {
  const storage = getLocalStorage();
  if (!storage) return;
  const timestamps = readLocalTimestamps();
  if (updatedAt == null) delete timestamps[path];
  else timestamps[path] = updatedAt;
  try { storage.setItem(LOCAL_TIMESTAMP_KEY, JSON.stringify(timestamps)); } catch {}
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
    listKeys: async () => await invoke("listKeys", { dataDir }) as Array<[string, number]>,
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
  async list(): Promise<NoteFileEntry[]> {
    const entries: NoteFileEntry[] = [];
    for (const [key, updatedAt] of await this.io.listKeys()) {
      try {
        entries.push({ key, text: await this.load(key), updatedAt });
      } catch {
        // An unreadable note is skipped rather than synced as empty.
      }
    }
    return entries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async loadQuickNotesIndex(): Promise<QuickNoteEntry[]> {
    try {
      const raw = await this.io.read(QUICK_NOTES_INDEX_FILE);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  async saveQuickNotesIndex(entries: QuickNoteEntry[]): Promise<void> {
    await this.io.write(QUICK_NOTES_INDEX_FILE, JSON.stringify(entries));
  }

  quickNoteKey(id: string): string {
    return `__note-${id}__`;
  }
}
