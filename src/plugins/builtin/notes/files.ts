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

const QUICK_NOTES_INDEX = "__quick-notes-index__";
const LOCAL_TIMESTAMP_KEY = "gloomberb:notes:__updated-at__";

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getLocalStorage(): LocalStorageLike | null {
  return (globalThis as { localStorage?: LocalStorageLike }).localStorage ?? null;
}

async function readTextFile(path: string): Promise<string> {
  if (typeof Bun !== "undefined") {
    const fsModulePath = "fs/promises";
    const { readFile } = await import(fsModulePath) as typeof import("fs/promises");
    return readFile(path, "utf-8");
  }
  return getLocalStorage()?.getItem(`gloomberb:notes:${path}`) ?? "";
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

async function writeTextFile(path: string, value: string): Promise<void> {
  if (typeof Bun !== "undefined") {
    const fsModulePath = "fs/promises";
    const { writeFile } = await import(fsModulePath) as typeof import("fs/promises");
    await writeFile(path, value, "utf-8");
    return;
  }
  getLocalStorage()?.setItem(`gloomberb:notes:${path}`, value);
  writeLocalTimestamp(path, Date.now());
}

async function deleteTextFile(path: string): Promise<void> {
  if (typeof Bun !== "undefined") {
    const fsModulePath = "fs/promises";
    const { unlink } = await import(fsModulePath) as typeof import("fs/promises");
    await unlink(path);
    return;
  }
  getLocalStorage()?.removeItem(`gloomberb:notes:${path}`);
  writeLocalTimestamp(path, null);
}

export class NotesFiles {
  constructor(private readonly dataDir: string) {}

  private pathFor(symbol: string): string {
    return joinPath(this.dataDir, `${symbol}.md`);
  }

  /**
   * A note that was never written is empty, but any other read failure is
   * rethrown: an unreadable note must not present itself as an empty editable
   * one, or the next save silently overwrites real content.
   */
  async load(symbol: string): Promise<string> {
    try {
      return await readTextFile(this.pathFor(symbol));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
      throw error;
    }
  }

  async save(symbol: string, notes: string): Promise<void> {
    await writeTextFile(this.pathFor(symbol), notes || "");
  }

  async delete(symbol: string): Promise<void> {
    try {
      await deleteTextFile(this.pathFor(symbol));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Every stored note, ticker notes and quick notes alike, newest first. */
  async list(): Promise<NoteFileEntry[]> {
    const entries: NoteFileEntry[] = [];
    for (const [key, updatedAt] of await this.listKeys()) {
      try {
        entries.push({ key, text: await this.load(key), updatedAt });
      } catch {
        // An unreadable note is skipped rather than synced as empty.
      }
    }
    return entries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async listKeys(): Promise<Array<[string, number]>> {
    if (typeof Bun !== "undefined") {
      const fsModulePath = "fs/promises";
      const { readdir, stat } = await import(fsModulePath) as typeof import("fs/promises");
      let names: string[];
      try {
        names = await readdir(this.dataDir);
      } catch {
        return [];
      }
      const keys: Array<[string, number]> = [];
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        try {
          const info = await stat(joinPath(this.dataDir, name));
          keys.push([name.slice(0, -3), Math.round(info.mtimeMs)]);
        } catch {}
      }
      return keys;
    }
    const prefix = joinPath(this.dataDir, "");
    const timestamps = readLocalTimestamps();
    const storageKeyPrefix = `gloomberb:notes:${prefix}`;
    // Notes written before the index existed are stamped now rather than at
    // the epoch, so an older cloud copy cannot overwrite them on first sync.
    for (const storageKey of Object.keys(globalThis.localStorage ?? {})) {
      if (!storageKey.startsWith(storageKeyPrefix) || !storageKey.endsWith(".md")) continue;
      const path = storageKey.slice("gloomberb:notes:".length);
      if (timestamps[path] == null) writeLocalTimestamp(path, timestamps[path] = Date.now());
    }
    return Object.entries(timestamps)
      .filter(([path]) => path.startsWith(prefix) && path.endsWith(".md"))
      .map(([path, updatedAt]) => [path.slice(prefix.length, -3), updatedAt]);
  }

  private indexPath(): string {
    return joinPath(this.dataDir, `${QUICK_NOTES_INDEX}.json`);
  }

  async loadQuickNotesIndex(): Promise<QuickNoteEntry[]> {
    try {
      const raw = await readTextFile(this.indexPath());
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async saveQuickNotesIndex(entries: QuickNoteEntry[]): Promise<void> {
    await writeTextFile(this.indexPath(), JSON.stringify(entries));
  }

  quickNoteKey(id: string): string {
    return `__note-${id}__`;
  }
}
