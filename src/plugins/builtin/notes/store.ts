import {
  apiClient,
  type CloudNote,
  type CloudNoteScope,
  type CloudNoteSummary,
  NoteConflictError,
  type NoteKind,
} from "../../../api-client";
import type { PluginPersistence } from "../../../types/plugin";
import type { NoteFileEntry, QuickNoteEntry } from "./files";

export { NoteConflictError };

const QUICK_KEY = /^__note-(.+)__$/;
const CACHE_SCHEMA_VERSION = 1;

/**
 * What the notes tabs need from wherever notes live. `NotesFiles` is the disk
 * implementation; `CloudNotesStore` is the cloud one. A future file-backed
 * notes plugin is another implementation of this.
 */
export interface NotesStore {
  /** True while saves cannot land: signed out, offline, or a team store without a session. */
  readonly readOnly: boolean;
  /** Who this store belongs to, for section headers and owner pickers. */
  readonly owner: NoteOwner;
  load(key: string): Promise<string>;
  save(key: string, text: string, options?: { title?: string | null }): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<NoteFileEntry[]>;
  loadQuickNotesIndex(): Promise<QuickNoteEntry[]>;
  saveQuickNotesIndex(entries: QuickNoteEntry[]): Promise<void>;
  quickNoteKey(id: string): string;
  /** Called after a server-side change so the next load sees it. */
  invalidate?(key?: string): void;
}

export type NoteOwner = { kind: "user" } | { kind: "team"; teamId: string };

export function noteOwnerKey(owner: NoteOwner): string {
  return owner.kind === "user" ? "user" : `team:${owner.teamId}`;
}

function noteOwnerScope(owner: NoteOwner): CloudNoteScope {
  return owner.kind === "user" ? { scope: "user" } : { scope: "team", teamId: owner.teamId };
}

/** Splits a store key into the cloud (kind, key) pair. */
export function splitNoteKey(key: string): { kind: NoteKind; key: string } {
  const quick = QUICK_KEY.exec(key);
  return quick?.[1] ? { kind: "quick", key: quick[1] } : { kind: "ticker", key: key.toUpperCase() };
}

export function joinNoteKey(kind: NoteKind, key: string): string {
  return kind === "quick" ? `__note-${key}__` : key;
}

interface CachedNote {
  id: string;
  revision: number;
  title: string | null;
  content: string;
  updatedAt: string;
  updatedBy: string;
}

type Cache = Record<string, CachedNote>;

/**
 * Cloud notes for one owner with a read-through cache in plugin persistence.
 * Reads go to the server when a session exists and fall back to the cache
 * otherwise; writes carry If-Match so an edit by a teammate since the note
 * was loaded surfaces as NoteConflictError instead of being overwritten.
 */
export class CloudNotesStore implements NotesStore {
  private index: Map<string, CloudNoteSummary> | null = null;
  private indexPromise: Promise<Map<string, CloudNoteSummary>> | null = null;

  constructor(
    readonly owner: NoteOwner,
    private readonly persistence: PluginPersistence | null,
    private readonly client: Pick<typeof apiClient, "isVerified" | "listCloudNotes" | "getCloudNote" | "putCloudNote" | "deleteCloudNote"> = apiClient,
  ) {}

  get readOnly(): boolean {
    return !this.client.isVerified();
  }

  private get cacheKey(): string {
    return `notes:cache:${noteOwnerKey(this.owner)}`;
  }

  private readCache(): Cache {
    return this.persistence?.getState<Cache>(this.cacheKey, { schemaVersion: CACHE_SCHEMA_VERSION }) ?? {};
  }

  private writeCache(mutate: (cache: Cache) => void): void {
    if (!this.persistence) return;
    const cache = this.readCache();
    mutate(cache);
    this.persistence.setState(this.cacheKey, cache, { schemaVersion: CACHE_SCHEMA_VERSION });
  }

  private remember(key: string, note: CloudNote): void {
    this.writeCache((cache) => {
      cache[key] = {
        id: note.id,
        revision: note.revision,
        title: note.title,
        content: note.content,
        updatedAt: note.updatedAt,
        updatedBy: note.updatedBy.username ? `@${note.updatedBy.username}` : note.updatedBy.displayName,
      };
    });
    this.index?.set(key, { ...note, size: note.content.length });
  }

  cached(key: string): CachedNote | null {
    return this.readCache()[key] ?? null;
  }

  invalidate(key?: string): void {
    this.index = null;
    this.indexPromise = null;
    if (key) this.writeCache((cache) => { delete cache[key]; });
  }

  private async loadIndex(): Promise<Map<string, CloudNoteSummary>> {
    if (this.index) return this.index;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = this.client.listCloudNotes(noteOwnerScope(this.owner))
      .then((items) => {
        const index = new Map(items.map((item) => [joinNoteKey(item.kind, item.key), item]));
        this.index = index;
        // Drop cached bodies for notes that no longer exist upstream.
        this.writeCache((cache) => {
          for (const key of Object.keys(cache)) {
            if (!index.has(key)) delete cache[key];
          }
        });
        return index;
      })
      .finally(() => {
        this.indexPromise = null;
      });
    return this.indexPromise;
  }

  async load(key: string): Promise<string> {
    const cached = this.cached(key);
    if (this.readOnly) return cached?.content ?? "";
    let index: Map<string, CloudNoteSummary>;
    try {
      index = await this.loadIndex();
    } catch (error) {
      if (cached) return cached.content;
      throw error;
    }
    const summary = index.get(key);
    if (!summary) {
      if (cached) this.writeCache((cache) => { delete cache[key]; });
      return "";
    }
    if (cached && cached.revision === summary.revision) return cached.content;
    const note = await this.client.getCloudNote(summary.id);
    if (!note) return "";
    this.remember(key, note);
    return note.content;
  }

  async save(key: string, text: string, options: { title?: string | null } = {}): Promise<void> {
    if (this.readOnly) throw new Error("Sign in to save notes to Gloom Cloud.");
    const { kind, key: cloudKey } = splitNoteKey(key);
    const cached = this.cached(key);
    if (cached && cached.content === text && (options.title === undefined || options.title === cached.title)) return;
    const note = await this.client.putCloudNote({
      scope: noteOwnerScope(this.owner),
      kind,
      key: cloudKey,
      content: text,
      ...(options.title !== undefined ? { title: options.title } : cached ? { title: cached.title } : {}),
      ...(cached ? { expectedRevision: cached.revision } : {}),
    });
    this.remember(key, note);
  }

  /** Accepts the server's copy after a conflict, so the next save is clean. */
  acceptCurrent(key: string, current: CloudNote): void {
    this.remember(key, current);
  }

  /** Forces the next save to overwrite whatever the server holds. */
  forgetRevision(key: string): void {
    this.writeCache((cache) => {
      const entry = cache[key];
      if (entry) cache[key] = { ...entry, revision: 0 };
    });
  }

  async delete(key: string): Promise<void> {
    if (this.readOnly) throw new Error("Sign in to delete notes in Gloom Cloud.");
    const index = await this.loadIndex();
    const summary = index.get(key);
    if (summary) await this.client.deleteCloudNote(summary.id);
    index.delete(key);
    this.writeCache((cache) => { delete cache[key]; });
  }

  async list(): Promise<NoteFileEntry[]> {
    if (this.readOnly) {
      return Object.entries(this.readCache())
        .map(([key, entry]) => ({ key, text: entry.content, updatedAt: Date.parse(entry.updatedAt) || 0 }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const index = await this.loadIndex();
    const entries: NoteFileEntry[] = [];
    for (const [key, summary] of index) {
      entries.push({ key, text: await this.load(key), updatedAt: Date.parse(summary.updatedAt) || 0 });
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadQuickNotesIndex(): Promise<QuickNoteEntry[]> {
    if (this.readOnly) {
      return Object.entries(this.readCache())
        .filter(([key]) => QUICK_KEY.test(key))
        .map(([key, entry]) => ({ id: splitNoteKey(key).key, title: entry.title ?? "Note", updatedAt: Date.parse(entry.updatedAt) || undefined }));
    }
    const index = await this.loadIndex();
    return [...index.values()]
      .filter((summary) => summary.kind === "quick")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((summary) => ({ id: summary.key, title: summary.title ?? "Note", updatedAt: Date.parse(summary.updatedAt) || undefined }));
  }

  /**
   * The index is the server's list, so saving it means writing titles: new
   * tabs become empty notes and renamed tabs carry their body along.
   */
  async saveQuickNotesIndex(entries: QuickNoteEntry[]): Promise<void> {
    if (this.readOnly) return;
    const index = await this.loadIndex();
    for (const entry of entries) {
      const key = joinNoteKey("quick", entry.id);
      const summary = index.get(key);
      if (summary && summary.title === entry.title) continue;
      const content = summary ? await this.load(key) : "";
      const cached = this.cached(key);
      const note = await this.client.putCloudNote({
        scope: noteOwnerScope(this.owner),
        kind: "quick",
        key: entry.id,
        title: entry.title,
        content,
        ...(cached ? { expectedRevision: cached.revision } : {}),
      });
      this.remember(key, note);
    }
  }

  quickNoteKey(id: string): string {
    return joinNoteKey("quick", id);
  }
}

/** One store per owner, created lazily; the registry decides cloud or disk. */
export class NotesStoreRegistry {
  private readonly stores = new Map<string, NotesStore>();

  constructor(
    private readonly options: {
      persistence: PluginPersistence | null;
      /** The disk store for personal notes while signed out. */
      files: NotesStore;
      isSignedIn: () => boolean;
    },
  ) {}

  /** Personal notes: cloud when signed in, the files on disk otherwise. */
  personal(): NotesStore {
    if (!this.options.isSignedIn()) return this.options.files;
    return this.forOwner({ kind: "user" });
  }

  forOwner(owner: NoteOwner): NotesStore {
    if (owner.kind === "user" && !this.options.isSignedIn()) return this.options.files;
    const key = noteOwnerKey(owner);
    let store = this.stores.get(key);
    if (!store) {
      store = new CloudNotesStore(owner, this.options.persistence);
      this.stores.set(key, store);
    }
    return store;
  }

  cloud(owner: NoteOwner): CloudNotesStore | null {
    const store = this.forOwner(owner);
    return store instanceof CloudNotesStore ? store : null;
  }

  invalidateAll(): void {
    for (const store of this.stores.values()) store.invalidate?.();
  }
}
