import { describe, expect, test } from "bun:test";
import type { CloudNote, CloudNoteScope, CloudNoteSummary } from "../../../api-client";
import { NoteConflictError } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { debugLog, type LogEntry } from "../../../utils/debug-log";
import { NotesFiles } from "./files";
import { migrateLocalNotes } from "./migration";
import { CloudNotesStore, joinNoteKey, NotesStoreRegistry, splitNoteKey } from "./store";

type ServerNote = CloudNote;

/** An in-memory stand-in for the notes routes, revisions included. */
function fakeServer(initial: ServerNote[] = []) {
  let verified = true;
  const notes = new Map<string, ServerNote>(initial.map((note) => [note.id, note]));
  const calls: string[] = [];
  let ids = initial.length;
  const keyOf = (scope: CloudNoteScope, kind: string, key: string) => `${scope.scope}:${scope.teamId ?? ""}:${kind}:${key}`;
  const find = (scope: CloudNoteScope, kind: string, key: string) => (
    [...notes.values()].find((note) => keyOf({ scope: note.owner.kind, teamId: note.owner.kind === "team" ? note.owner.id : undefined }, note.kind, note.key) === keyOf(scope, kind, key))
  );
  const client = {
    isVerified: () => verified,
    listCloudNotes: async (scope: CloudNoteScope): Promise<CloudNoteSummary[]> => {
      calls.push(`list ${scope.scope}`);
      return [...notes.values()]
        .filter((note) => note.owner.kind === scope.scope && (scope.scope === "user" || note.owner.id === scope.teamId))
        .map(({ content, ...rest }) => ({ ...rest, size: content.length }));
    },
    getCloudNote: async (id: string) => {
      calls.push(`get ${id}`);
      return notes.get(id) ?? null;
    },
    putCloudNote: async (input: { scope: CloudNoteScope; kind: "ticker" | "quick"; key: string; title?: string | null; content: string; expectedRevision?: number }) => {
      calls.push(`put ${input.kind}:${input.key}@${input.expectedRevision ?? "*"}`);
      const existing = find(input.scope, input.kind, input.key);
      if (existing && input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
        throw new NoteConflictError("This note was edited since you opened it.", existing);
      }
      const next: ServerNote = {
        id: existing?.id ?? `n${++ids}`,
        owner: input.scope.scope === "user" ? { kind: "user", id: "me" } : { kind: "team", id: input.scope.teamId! },
        kind: input.kind,
        key: input.key,
        title: input.title === undefined ? (existing?.title ?? null) : input.title,
        revision: existing ? existing.revision + 1 : 1,
        content: input.content,
        updatedBy: { id: "me", username: "ada", displayName: "Ada" },
        createdAt: existing?.createdAt ?? "2026-09-14T12:00:00.000Z",
        updatedAt: new Date(Date.parse("2026-09-14T12:00:00.000Z") + (existing ? existing.revision : 0) * 1000).toISOString(),
      };
      notes.set(next.id, next);
      return next;
    },
    deleteCloudNote: async (id: string) => {
      calls.push(`delete ${id}`);
      notes.delete(id);
    },
  };
  return {
    client,
    calls,
    notes,
    setVerified: (value: boolean) => {
      verified = value;
    },
    editByTeammate: (id: string, content: string) => {
      const note = notes.get(id)!;
      notes.set(id, { ...note, content, revision: note.revision + 1, updatedBy: { id: "u2", username: "alice", displayName: "Alice" } });
    },
  };
}

describe("note keys", () => {
  test("ticker and quick keys round-trip", () => {
    expect(splitNoteKey("aapl")).toEqual({ kind: "ticker", key: "AAPL" });
    expect(splitNoteKey("__note-abc__")).toEqual({ kind: "quick", key: "abc" });
    expect(joinNoteKey("quick", "abc")).toBe("__note-abc__");
    expect(joinNoteKey("ticker", "AAPL")).toBe("AAPL");
  });
});

describe("CloudNotesStore", () => {
  test("loads through the index, caches by revision, and saves with If-Match", async () => {
    const server = fakeServer();
    const persistence = new MemoryPluginPersistence();
    const store = new CloudNotesStore({ kind: "user" }, persistence, server.client);

    expect(await store.load("AAPL")).toBe("");
    await store.save("AAPL", "Earnings soon");
    expect(server.calls.at(-1)).toBe("put ticker:AAPL@*");
    expect(await store.load("AAPL")).toBe("Earnings soon");
    // The second load is served from the cache: no extra get.
    expect(server.calls.filter((call) => call.startsWith("get")).length).toBe(0);

    await store.save("AAPL", "Earnings on the 30th");
    expect(server.calls.at(-1)).toBe("put ticker:AAPL@1");
    expect(store.cached("AAPL")?.revision).toBe(2);

    // Unchanged content is not sent.
    const before = server.calls.length;
    await store.save("AAPL", "Earnings on the 30th");
    expect(server.calls.length).toBe(before);
  });

  test("surfaces a teammate's edit as a conflict and can accept or overwrite", async () => {
    const server = fakeServer();
    const store = new CloudNotesStore({ kind: "team", teamId: "org-1" }, new MemoryPluginPersistence(), server.client);
    await store.save("NVDA", "v1");
    const id = [...server.notes.keys()][0]!;
    server.editByTeammate(id, "theirs");

    let caught: unknown;
    await store.save("NVDA", "mine").catch((error: unknown) => {
      caught = error;
    });
    expect(caught).toBeInstanceOf(NoteConflictError);
    const conflict = caught as NoteConflictError;
    expect(conflict.current).toMatchObject({ content: "theirs", revision: 2, updatedBy: { username: "alice" } });

    // Overwrite: accept their revision as the base, then save mine on top.
    store.acceptCurrent("NVDA", conflict.current!);
    await store.save("NVDA", "mine");
    expect(server.notes.get(id)?.content).toBe("mine");
    expect(server.notes.get(id)?.revision).toBe(3);
  });

  test("goes read-only from the cache when signed out and lists quick notes", async () => {
    const server = fakeServer();
    const persistence = new MemoryPluginPersistence();
    const store = new CloudNotesStore({ kind: "user" }, persistence, server.client);
    await store.saveQuickNotesIndex([{ id: "q1", title: "Ideas" }]);
    await store.save(store.quickNoteKey("q1"), "Rotate into rates");
    expect(await store.loadQuickNotesIndex()).toEqual([{ id: "q1", title: "Ideas", updatedAt: expect.any(Number) }]);

    // Rename only rewrites the title, carrying the body.
    await store.saveQuickNotesIndex([{ id: "q1", title: "Rates ideas" }]);
    expect([...server.notes.values()][0]).toMatchObject({ title: "Rates ideas", content: "Rotate into rates" });

    server.setVerified(false);
    expect(store.readOnly).toBe(true);
    expect(await store.load(store.quickNoteKey("q1"))).toBe("Rotate into rates");
    expect(await store.loadQuickNotesIndex()).toEqual([{ id: "q1", title: "Rates ideas", updatedAt: expect.any(Number) }]);
    await expect(store.save("AAPL", "x")).rejects.toThrow("Sign in");
  });

  test("delete drops the server row and the cache", async () => {
    const server = fakeServer();
    const store = new CloudNotesStore({ kind: "user" }, new MemoryPluginPersistence(), server.client);
    await store.save("TSLA", "hi");
    await store.delete("TSLA");
    expect(server.notes.size).toBe(0);
    expect(store.cached("TSLA")).toBeNull();
    expect(await store.load("TSLA")).toBe("");
  });
});

describe("NotesStoreRegistry", () => {
  test("hands out the disk store while signed out and the cloud store once signed in", () => {
    const files = new NotesFiles("/tmp/gloomberb-notes-registry-test");
    let signedIn = false;
    const registry = new NotesStoreRegistry({ persistence: null, files, isSignedIn: () => signedIn });
    expect(registry.personal()).toBe(files);
    expect(registry.cloud({ kind: "user" })).toBeNull();
    signedIn = true;
    expect(registry.personal()).toBeInstanceOf(CloudNotesStore);
    expect(registry.forOwner({ kind: "team", teamId: "org-1" })).toBe(registry.forOwner({ kind: "team", teamId: "org-1" }));
  });
});

describe("migrateLocalNotes", () => {
  test("uploads local files the cloud lacks or has older, once", async () => {
    const dir = `/tmp/gloomberb-notes-migration-${Date.now()}`;
    const files = new NotesFiles(dir);
    const fs = await import("fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await files.save("AAPL", "local apple");
    await files.save("MSFT", "local microsoft");
    // Empty placeholder files stay local; an option symbol with OCC padding goes up.
    await files.save("NVDA", "");
    await files.save("AMD   270917C00230000", "call spread notes");
    await files.saveQuickNotesIndex([{ id: "q1", title: "Ideas" }, { id: "q2", title: "Empty tab" }]);
    await files.save(files.quickNoteKey("q1"), "quick body");

    const server = fakeServer([{
      id: "n-existing",
      owner: { kind: "user", id: "me" },
      kind: "ticker",
      key: "MSFT",
      title: null,
      content: "cloud microsoft, newer",
      revision: 4,
      updatedBy: { id: "me", username: "ada", displayName: "Ada" },
      createdAt: "2026-09-14T12:00:00.000Z",
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    }]);
    const persistence = new MemoryPluginPersistence();
    const cloud = new CloudNotesStore({ kind: "user" }, persistence, server.client);

    const result = await migrateLocalNotes(files, cloud, persistence);
    expect(result).toEqual({ uploaded: 4, skipped: 2, rejected: [] });
    const byKey = new Map([...server.notes.values()].map((note) => [`${note.kind}:${note.key}`, note]));
    expect(byKey.get("ticker:AAPL")?.content).toBe("local apple");
    expect(byKey.get("ticker:AMD   270917C00230000")?.content).toBe("call spread notes");
    expect(byKey.has("ticker:NVDA")).toBe(false);
    expect(byKey.get("ticker:MSFT")?.content).toBe("cloud microsoft, newer");
    expect(byKey.get("quick:q1")).toMatchObject({ title: "Ideas", content: "quick body" });
    expect(byKey.get("quick:q2")).toMatchObject({ title: "Empty tab", content: "" });

    expect(await migrateLocalNotes(files, cloud, persistence)).toBeNull();
    expect(await files.load("AAPL")).toBe("local apple");
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("a key the server refuses is logged once and does not block the stamp", async () => {
    const dir = `/tmp/gloomberb-notes-migration-reject-${Date.now()}`;
    const files = new NotesFiles(dir);
    const fs = await import("fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await files.save("GOOD", "fine");
    await files.save("BAD", "refused");
    const server = fakeServer([]);
    const client = {
      ...server.client,
      putCloudNote: async (input: Parameters<typeof server.client.putCloudNote>[0]) => {
        if (input.key === "BAD") throw new ApiRequestError("Invalid note key.", 400);
        return server.client.putCloudNote(input);
      },
    };
    const persistence = new MemoryPluginPersistence();
    const cloud = new CloudNotesStore({ kind: "user" }, persistence, client);
    const warnings: LogEntry[] = [];
    const unsubscribe = debugLog.subscribe((entry) => { if (entry.level === "warn") warnings.push(entry); });
    try {
      expect(await migrateLocalNotes(files, cloud, persistence)).toEqual({ uploaded: 1, skipped: 0, rejected: ["BAD"] });
    } finally {
      unsubscribe();
    }
    expect(warnings[0]?.data).toEqual({ rejected: ["BAD"] });
    // Stamped: the next launch does not try again.
    expect(await migrateLocalNotes(files, cloud, persistence)).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
