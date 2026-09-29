import { describe, expect, test } from "bun:test";
import type { CloudSearchHit } from "../../../api-client";
import { hitDocumentKey } from "./model";

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

// Later pages are deduped on this key, so it has to name the document rather
// than whichever chunk of it scored best on that page.
describe("hitDocumentKey", () => {
  test("a document is the same row under a different chunk", () => {
    expect(hitDocumentKey(hit({ id: "chunk-9", chunkIndex: 9 })))
      .toBe(hitDocumentKey(hit({ id: "chunk-4", chunkIndex: 4 })));
    expect(hitDocumentKey(hit({ id: "other", sourceId: "0000320193-26-000002" })))
      .not.toBe(hitDocumentKey(hit({ id: "chunk-4", chunkIndex: 4 })));
  });

  test("documents of different types that share a source id stay apart", () => {
    expect(hitDocumentKey(hit({ docType: "news", sourceId: "shared" })))
      .not.toBe(hitDocumentKey(hit({ docType: "filing", sourceId: "shared" })));
  });
});
