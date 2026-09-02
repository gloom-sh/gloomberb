import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { CloudSearchDocument, CloudSearchHit } from "../../../api-client";
import { SearchDocumentView } from "./document-view";

// One unbroken run, so every wrapped line is exactly as wide as the wrap width
// and the rightmost printed column is the wrap width rather than wherever the
// last word happened to end.
const PARAGRAPH = "forward-looking-statement.".repeat(40);

const HIT = {
  id: "hit-1",
  docType: "news",
  sourceId: "doc-1",
  chunkIndex: 0,
  ticker: "NVDA",
  publishedAt: "2026-08-31T12:00:00.000Z",
  title: "Press Release",
  url: "https://example.com/doc-1",
  snippet: "lorem <mark>ipsum</mark> dolor",
  score: 1,
  metadata: { source: "Business Wire" },
} as unknown as CloudSearchHit;

const DOCUMENT = {
  docType: "news",
  sourceId: "doc-1",
  ticker: "NVDA",
  title: "Press Release",
  url: "https://example.com/doc-1",
  publishedAt: "2026-08-31T12:00:00.000Z",
  chunks: Array.from({ length: 4 }, (_, index) => ({
    id: `chunk-${index}`,
    chunkIndex: index,
    body: PARAGRAPH,
    metadata: { source: "Business Wire" },
  })),
} as unknown as CloudSearchDocument;

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
});

/**
 * The wrap width, the scroll box's inset and its scrollbar are three separate
 * subtractions from the same pane, and counting one of them twice is invisible
 * in review: the text still renders, just short of the edge.
 */
for (const width of [60, 88, 120]) {
  test(`paragraphs reach the column before the scrollbar at width ${width}`, async () => {
    testSetup = await testRender(
      <SearchDocumentView hit={HIT} document={DOCUMENT} loading={false} error={null} width={width} />,
      { width, height: 20 },
    );
    for (let frame = 0; frame < 3; frame += 1) {
      await act(async () => {
        await testSetup!.renderOnce();
      });
    }

    const rows = testSetup.captureCharFrame().split("\n");
    // The scrollbar owns the last column on every row it covers, so measure the
    // text against the column before it.
    const textRight = Math.max(...rows.map((row) => row.slice(0, width - 1).trimEnd().length));
    expect(textRight).toBe(width - 1);
  });
}
