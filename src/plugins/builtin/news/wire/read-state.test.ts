import { describe, expect, test } from "bun:test";
import {
  MAX_READ_ARTICLE_IDS,
  markNewsArticleRead,
  normalizeNewsReadState,
  type NewsReadState,
} from "./read-state";

describe("news read state", () => {
  test("marks opened articles as read with the most recent first", () => {
    const state = markNewsArticleRead({ articleIds: ["old"] }, "new");

    expect(state.articleIds).toEqual(["new", "old"]);
  });

  test("deduplicates existing read articles when reopened", () => {
    const state = markNewsArticleRead({ articleIds: ["a", "b", "a"] }, "b");

    expect(state.articleIds).toEqual(["b", "a"]);
  });

  test("keeps persisted read state bounded", () => {
    const state = normalizeNewsReadState({
      articleIds: Array.from({ length: MAX_READ_ARTICLE_IDS + 25 }, (_, index) => `id-${index}`),
    });

    expect(state.articleIds).toHaveLength(MAX_READ_ARTICLE_IDS);
    expect(state.articleIds[0]).toBe("id-0");
    expect(state.articleIds.at(-1)).toBe(`id-${MAX_READ_ARTICLE_IDS - 1}`);
  });

  test("repairs persisted state with a missing article list", () => {
    const state = normalizeNewsReadState({} as NewsReadState);

    expect(state).toEqual({ articleIds: [] });
  });
});
