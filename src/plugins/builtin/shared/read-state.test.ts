import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_READ_IDS,
  markPersistedReadId,
  normalizePersistedReadIdState,
  type PersistedReadIdAdapter,
} from "./read-state";

interface ReadState {
  ids: string[];
}

const adapter: PersistedReadIdAdapter<ReadState> = {
  getIds: (state) => state.ids,
  withIds: (_state, ids) => ({ ids }),
};

describe("persisted read ids", () => {
  test("marks the opened id first and drops its earlier copies", () => {
    expect(markPersistedReadId({ ids: ["old"] }, "new", adapter).ids).toEqual(["new", "old"]);
    expect(markPersistedReadId({ ids: ["a", "b", "a"] }, "b", adapter).ids).toEqual(["b", "a"]);
  });

  test("keeps persisted read state bounded", () => {
    const state = normalizePersistedReadIdState({
      ids: Array.from({ length: DEFAULT_MAX_READ_IDS + 25 }, (_, index) => `id-${index}`),
    }, adapter);

    expect(state.ids).toHaveLength(DEFAULT_MAX_READ_IDS);
    expect(state.ids[0]).toBe("id-0");
    expect(state.ids.at(-1)).toBe(`id-${DEFAULT_MAX_READ_IDS - 1}`);
  });

  test("repairs persisted state with a missing id list", () => {
    expect(normalizePersistedReadIdState({} as ReadState, adapter)).toEqual({ ids: [] });
  });
});
