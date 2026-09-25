import { describe, expect, it } from "bun:test";
import { QueryStore } from "./query-store";
import type { QueryEntry } from "./result-types";

function ready(value: string): QueryEntry<string> {
  return {
    phase: "ready",
    data: value,
    lastGoodData: value,
    source: "test",
    fetchedAt: 0,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

function retainedKeys(store: QueryStore<string>, keys: string[]): string[] {
  return keys.filter((key) => store.get(key).phase !== "idle");
}

describe("QueryStore retention", () => {
  it("drops the least recently written unwatched entries past the ceiling", () => {
    const evicted: string[] = [];
    const store = new QueryStore<string>(() => {}, { maxRetainedEntries: 2, onEvict: (key) => evicted.push(key) });
    for (const key of ["a", "b", "c"]) store.set(key, ready(key));
    // A refresh of b makes it newer than c, though c was opened later.
    store.update("b", () => ready("b2"));
    store.set("d", ready("d"));

    expect(evicted).toEqual(["a", "c"]);
    expect(retainedKeys(store, ["a", "b", "c", "d"])).toEqual(["b", "d"]);
  });

  it("keeps watched keys outside the ceiling, so a large portfolio still leaves room to browse", () => {
    const watched = new Set(["w1", "w2", "w3"]);
    const store = new QueryStore<string>(() => {}, { maxRetainedEntries: 2, isWatched: (key) => watched.has(key) });
    for (const key of ["w1", "w2", "w3", "a", "b", "c"]) store.set(key, ready(key));

    expect(retainedKeys(store, ["w1", "w2", "w3", "a", "b", "c"])).toEqual(["w1", "w2", "w3", "b", "c"]);
  });

  it("treats a key a pane lets go of as the most recently used", () => {
    const watched = new Set(["a"]);
    const store = new QueryStore<string>(() => {}, { maxRetainedEntries: 3, isWatched: (key) => watched.has(key) });
    for (const key of ["a", "b", "c"]) store.set(key, ready(key));
    watched.add("b");
    store.watch("b");
    watched.delete("a");
    store.release("a");
    store.set("d", ready("d"));
    store.set("e", ready("e"));

    // a was opened first but left last; b is on screen again.
    expect(retainedKeys(store, ["a", "b", "c", "d", "e"])).toEqual(["a", "b", "d", "e"]);
  });
});
