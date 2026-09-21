import { afterEach, expect, test } from "bun:test";
import type {
  ASKGConversationSummary,
  ASKGTransport,
} from "../../../../api-client/askg";
import {
  ASKGConversationListStore,
  askgConversationLabel,
  UNTITLED_ASKG_CONVERSATION,
} from "./conversation-store";

function summary(
  id: string,
  title: string | null,
): ASKGConversationSummary {
  const at = "2026-09-20T10:00:00.000Z";
  return {
    id,
    title,
    messageCount: 2,
    lastMessageAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

interface Stub {
  store: ASKGConversationListStore;
  calls: string[];
  resolveList: (conversations: ASKGConversationSummary[]) => void;
  failList: (error: Error) => void;
  renameResult: { value: ASKGConversationSummary | null | Error };
  deleteResult: { value: boolean | Error };
}

function createStub(): Stub {
  const calls: string[] = [];
  let pending: {
    resolve: (value: ASKGConversationSummary[]) => void;
    reject: (error: Error) => void;
  } | null = null;
  const queued: ASKGConversationSummary[][] = [];
  const renameResult: Stub["renameResult"] = { value: null };
  const deleteResult: Stub["deleteResult"] = { value: true };

  const transport = {
    listConversations: async () => {
      calls.push("list");
      const ready = queued.shift();
      if (ready) return ready;
      return new Promise<ASKGConversationSummary[]>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    renameConversation: async (id: string, title: string | null) => {
      calls.push(`rename:${id}:${title ?? "null"}`);
      if (renameResult.value instanceof Error) throw renameResult.value;
      return renameResult.value;
    },
    deleteConversation: async (id: string) => {
      calls.push(`delete:${id}`);
      if (deleteResult.value instanceof Error) throw deleteResult.value;
      return deleteResult.value;
    },
  } as unknown as ASKGTransport;

  const store = new ASKGConversationListStore();
  store.useTransport(transport);
  return {
    store,
    calls,
    resolveList: (conversations) => {
      if (pending) {
        const settle = pending;
        pending = null;
        settle.resolve(conversations);
        return;
      }
      queued.push(conversations);
    },
    failList: (error) => {
      const settle = pending;
      pending = null;
      settle?.reject(error);
    },
    renameResult,
    deleteResult,
  };
}

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

let active: ASKGConversationListStore | null = null;
afterEach(() => {
  active?.reset();
  active = null;
});

test("concurrent refreshes share one request", async () => {
  const stub = createStub();
  active = stub.store;

  const first = stub.store.refresh();
  const second = stub.store.refresh();
  expect(stub.store.getSnapshot().loading).toBe(true);

  stub.resolveList([summary("conv-1", "Bonds")]);
  await Promise.all([first, second]);

  expect(stub.calls).toEqual(["list"]);
  expect(stub.store.getSnapshot().conversations).toHaveLength(1);
  expect(stub.store.getSnapshot().loading).toBe(false);
  expect(stub.store.getSnapshot().loaded).toBe(true);
});

test("ensureLoaded asks once, and refresh asks again", async () => {
  const stub = createStub();
  active = stub.store;

  stub.resolveList([summary("conv-1", "Bonds")]);
  stub.store.ensureLoaded();
  await settle();
  stub.store.ensureLoaded();
  await settle();
  expect(stub.calls).toEqual(["list"]);

  stub.resolveList([summary("conv-1", "Bonds"), summary("conv-2", "Margins")]);
  await stub.store.refresh();
  expect(stub.calls).toEqual(["list", "list"]);
  expect(stub.store.getSnapshot().conversations).toHaveLength(2);
});

test("a failed refresh keeps the rows already on screen", async () => {
  const stub = createStub();
  active = stub.store;

  stub.resolveList([summary("conv-1", "Bonds")]);
  await stub.store.refresh();

  const failing = stub.store.refresh();
  stub.failList(new Error("Connection lost"));
  await failing;

  const snapshot = stub.store.getSnapshot();
  expect(snapshot.error).toBe("Connection lost");
  expect(snapshot.loading).toBe(false);
  expect(snapshot.conversations).toHaveLength(1);
});

test("a rename reads as applied before the server answers", async () => {
  const stub = createStub();
  active = stub.store;
  stub.resolveList([summary("conv-1", "Bonds")]);
  await stub.store.refresh();

  stub.renameResult.value = summary("conv-1", "Treasuries");
  const renaming = stub.store.rename("conv-1", "Treasuries");
  expect(stub.store.getSnapshot().conversations[0]?.title).toBe("Treasuries");
  await renaming;
  expect(stub.store.getSnapshot().conversations[0]?.title).toBe("Treasuries");
  expect(stub.calls).toContain("rename:conv-1:Treasuries");
});

test("renaming a conversation that is gone drops the row", async () => {
  const stub = createStub();
  active = stub.store;
  stub.resolveList([summary("conv-1", "Bonds")]);
  await stub.store.refresh();

  stub.renameResult.value = null;
  await stub.store.rename("conv-1", "Treasuries");
  expect(stub.store.getSnapshot().conversations).toEqual([]);
});

test("a delete that fails puts the row back", async () => {
  const stub = createStub();
  active = stub.store;
  stub.resolveList([summary("conv-1", "Bonds"), summary("conv-2", "Margins")]);
  await stub.store.refresh();

  stub.deleteResult.value = new Error("Connection lost");
  await stub.store.delete("conv-1");

  const snapshot = stub.store.getSnapshot();
  expect(snapshot.conversations.map((entry) => entry.id)).toEqual([
    "conv-1",
    "conv-2",
  ]);
  expect(snapshot.error).toBe("Connection lost");
});

test("a conversation the pane just opened appears without waiting for a refresh", async () => {
  const stub = createStub();
  active = stub.store;
  stub.resolveList([]);
  await stub.store.refresh();

  stub.store.note("conv-new", "what does a 5y bond return");
  expect(stub.store.getSnapshot().conversations[0]).toMatchObject({
    id: "conv-new",
    title: "what does a 5y bond return",
  });

  // Noting it again must not duplicate the row or rewrite its title.
  stub.store.note("conv-new", "a different question");
  const rows = stub.store.getSnapshot().conversations;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.title).toBe("what does a 5y bond return");
});

test("a conversation with no title of its own still reads as something", () => {
  expect(askgConversationLabel(summary("conv-1", "Bonds"))).toBe("Bonds");
  expect(askgConversationLabel(summary("conv-1", "   "))).toBe(
    UNTITLED_ASKG_CONVERSATION,
  );
  expect(askgConversationLabel(summary("conv-1", null))).toBe(
    UNTITLED_ASKG_CONVERSATION,
  );
});

test("a store with no transport never reaches for a global", async () => {
  const store = new ASKGConversationListStore();
  active = store;
  await store.refresh();
  await store.rename("conv-1", "x");
  await store.delete("conv-1");
  expect(store.getSnapshot()).toMatchObject({ conversations: [], loaded: false });
});
