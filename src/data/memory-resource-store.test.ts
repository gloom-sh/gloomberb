import { describe, expect, test } from "bun:test";
import { MemoryResourceStore } from "./memory-resource-store";

describe("MemoryResourceStore", () => {
  test("returns expired records only when requested", () => {
    const store = new MemoryResourceStore();
    const key = {
      namespace: "plugins:prediction-markets",
      kind: "catalog",
      entityKey: "kalshi:all:all",
      sourceKey: "remote",
    };

    store.set(key, ["expired"], {
      cachePolicy: { staleMs: -2, expireMs: -1 },
      fetchedAt: Date.now(),
    });

    expect(store.get(key)).toBeNull();
    expect(store.get<string[]>(key, { allowExpired: true })?.value).toEqual([
      "expired",
    ]);
  });
});
