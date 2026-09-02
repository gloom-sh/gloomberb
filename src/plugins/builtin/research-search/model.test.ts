import { describe, expect, test } from "bun:test";
import type { CloudSearchHit } from "../../../api-client";
import { appendUniqueHits } from "./model";

function hit(overrides: Partial<CloudSearchHit>): CloudSearchHit {
  return {
    id: "hit",
    docType: "filing",
    sourceId: "0000320193-26-000001",
    chunkIndex: 0,
    ticker: "AAPL",
    publishedAt: "2026-05-02T21:00:00.000Z",
    title: "Apple Inc. 10-Q",
    url: "https://example.com/filing",
    snippet: "gross margin",
    score: 1,
    metadata: {},
    ...overrides,
  };
}

describe("appendUniqueHits", () => {
  test("drops a document that arrives again under a different chunk", () => {
    const first = [hit({ id: "chunk-4", chunkIndex: 4 })];
    const second = [
      hit({ id: "chunk-9", chunkIndex: 9 }),
      hit({ id: "other", sourceId: "0000320193-26-000002" }),
    ];

    expect(appendUniqueHits(first, second).map((entry) => entry.id))
      .toEqual(["chunk-4", "other"]);
  });

  test("keeps documents of different types that share a source id", () => {
    const first = [hit({ id: "news", docType: "news", sourceId: "shared" })];
    const second = [hit({ id: "filing", docType: "filing", sourceId: "shared" })];

    expect(appendUniqueHits(first, second)).toHaveLength(2);
  });
});
