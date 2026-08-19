export interface QuickNoteEntry {
  id: string;
  title: string;
  updatedAt?: number;
}

const QUICK_NOTES_INDEX = "__quick-notes-index__";

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

async function writeTextFile(path: string, value: string): Promise<void> {
  if (typeof Bun !== "undefined") {
    const fsModulePath = "fs/promises";
    const { writeFile } = await import(fsModulePath) as typeof import("fs/promises");
    await writeFile(path, value, "utf-8");
    return;
  }
  getLocalStorage()?.setItem(`gloomberb:notes:${path}`, value);
}

async function deleteTextFile(path: string): Promise<void> {
  if (typeof Bun !== "undefined") {
    const fsModulePath = "fs/promises";
    const { unlink } = await import(fsModulePath) as typeof import("fs/promises");
    await unlink(path);
    return;
  }
  getLocalStorage()?.removeItem(`gloomberb:notes:${path}`);
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
