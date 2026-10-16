import { describe, expect, test } from "bun:test";
import type { ChatMentionCandidate } from "../../../../api-client";
import { ChatMentionCandidates } from "./mention-candidates";

const person: ChatMentionCandidate = {
  id: "quiet", username: "quiet", displayName: "Quiet Member",
  channelActivityAt: null, conversationActivityAt: null,
};

function fixture() {
  let user: string | null = "reader";
  let active = ["one"];
  const requests: Array<{ id: string } & ReturnType<typeof Promise.withResolvers<ChatMentionCandidate[]>>> = [];
  const changed: string[] = [];
  const cache = new ChatMentionCandidates({
    userId: () => user,
    activeChannels: () => active,
    fetch: (id) => {
      const pending = { id, ...Promise.withResolvers<ChatMentionCandidate[]>() };
      requests.push(pending);
      return pending.promise;
    },
    emit: (id) => changed.push(id),
  });
  return { cache, requests, changed, account: (next: string | null) => { user = next; }, active: (next: string[]) => { active = next; } };
}

describe("mention member cache", () => {
  test("cold reads are single-flight, warm reads local, and channels never share entries", async () => {
    const { cache, requests } = fixture();
    expect(cache.get("one")).toBeUndefined();
    const loading = cache.load("one");
    expect(cache.load("one")).toBe(loading);
    for (let key = 0; key < 100; key++) cache.get("one");
    expect(requests).toHaveLength(1);
    requests[0]!.resolve([person]);
    await loading;
    await cache.load("one");
    expect(requests).toHaveLength(1);
    expect(cache.get("one")).toEqual([person]);
    const next = cache.load("two");
    expect(cache.get("two")).toBeUndefined();
    requests[1]!.resolve([]);
    await next;
    expect(cache.get("two")).toEqual([]);
    expect(cache.get("one")).toEqual([person]);
  });

  test("membership changes and reconnects discard old responses, hide stale identities, and refetch once", async () => {
    const { cache, requests } = fixture();
    const loading = cache.load("one");
    cache.invalidate();
    cache.invalidate();
    expect(cache.get("one")).toEqual([]);
    expect(requests).toHaveLength(1);
    requests[0]!.resolve([person]);
    await loading;
    expect(cache.get("one")).toEqual([]);
    expect(requests).toHaveLength(2);
    const refreshed = cache.load("one");
    requests[1]!.resolve([{ ...person, id: "joined", username: "joined" }]);
    await refreshed;
    expect(cache.get("one")?.[0]?.id).toBe("joined");
    cache.invalidate();
    const denied = cache.load("one");
    requests[2]!.reject(new Error("Access revoked"));
    await denied;
    expect(cache.get("one")).toEqual([]);
  });

  test("a closed channel refreshes on reopen, and account changes or disposal reject late results", async () => {
    const { cache, requests, account, active } = fixture();
    let loading = cache.load("one");
    requests[0]!.resolve([person]);
    await loading;
    active([]);
    cache.invalidate();
    expect(requests).toHaveLength(1);
    loading = cache.load("one");
    account("other");
    expect(cache.get("one")).toBeUndefined();
    requests[1]!.resolve([person]);
    await loading;
    expect(cache.get("one")).toBeUndefined();
    loading = cache.load("one");
    cache.clear();
    requests[2]!.resolve([person]);
    await loading;
    expect(cache.get("one")).toBeUndefined();
    account(null);
    await cache.load("one");
    expect(requests).toHaveLength(3);
  });

  test("new DM activity updates only already eligible people locally and never moves backward", async () => {
    const { cache, requests } = fixture();
    const loading = cache.load("one");
    requests[0]!.resolve([person]);
    await loading;
    cache.recordConversation(["quiet", "outsider"], "2026-06-30T00:00:00Z");
    cache.recordConversation(["quiet"], "2026-06-29T00:00:00Z");
    expect(cache.get("one")).toEqual([{ ...person, conversationActivityAt: "2026-06-30T00:00:00Z" }]);
    expect(requests).toHaveLength(1);
  });

  test("a failed cold request keeps the loaded-author fallback and retries on reconnect", async () => {
    const { cache, requests } = fixture();
    const loading = cache.load("one");
    requests[0]!.reject(new Error("Offline"));
    await loading;
    expect(cache.get("one")).toBeUndefined();
    cache.invalidate();
    expect(requests).toHaveLength(2);
    const retry = cache.load("one");
    requests[1]!.resolve([person]);
    await retry;
    expect(cache.get("one")).toEqual([person]);
  });
});
