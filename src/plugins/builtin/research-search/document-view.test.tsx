import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import type { CloudSearchDocument, CloudSearchHit } from "../../../api-client";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { SearchDocumentView } from "./document-view";

// An invented wire story laid out the way a scraped page arrives: chrome
// first, then one paragraph of several hundred words, then company sections.
const INTRO = Array.from({ length: 6 }, (_, index) => (
  `Chip stocks moved again on day ${index + 1} as traders weighed spending plans. The Orbis Semiconductor Index ended the session lower while the broader market slipped. Analysts said the move was orderly.`
)).join(" ");

const BODY = [
  "Wirefeed Daily",
  "Chip Stocks Cool After Record Run",
  "News provided by",
  "Market Lens",
  "Oct 10, 2026, 12:38 ET",
  "Share this article",
  "Share to X",
  `HALIFAX, NS, Oct. 10, 2026 /Wirefeed/ -- ${INTRO}`,
  ...["Halvard Microsystems", "Kestrel Foundry Corp.", "Ondine Memory Inc.", "Pellam Devices plc"].flatMap((name, index) => [
    `${name} (NASDAQ: TK${index})`,
    `${name.split(" ")[0]} shares moved ${index + 2}.1% for the week after the company updated its outlook for the second half. It said demand from data center builders stayed firm and that it expects to keep its plants busy through the middle of 2027.`,
  ]),
].join("\n");

const HIT = {
  id: "hit-1",
  docType: "news",
  sourceId: "doc-1",
  chunkIndex: 0,
  ticker: "TK0",
  publishedAt: "2026-10-10T16:38:00.000Z",
  title: "Chip Stocks Cool After Record Run",
  url: "https://wirefeed.example/doc-1",
  snippet: "the <mark>Orbis</mark> index",
  score: 1,
  metadata: { source: "Wirefeed Daily" },
} as unknown as CloudSearchHit;

const DOCUMENT = {
  docType: "news",
  sourceId: "doc-1",
  ticker: "TK0",
  title: "Chip Stocks Cool After Record Run",
  url: "https://wirefeed.example/doc-1",
  publishedAt: "2026-10-10T16:38:00.000Z",
  chunks: [{ id: "chunk-0", chunkIndex: 0, body: BODY, metadata: { source: "Wirefeed Daily" } }],
} as unknown as CloudSearchDocument;

const tui = createOpenTuiTestHarness();

async function renderReader(width: number, height: number) {
  const state = createInitialState(createTestPaneConfig("/tmp/glo592-reader-unused", { instanceId: "srch", paneId: "research-search" }));
  state.focusedPaneId = "srch";
  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId="srch" pluginId="research-search" runtime={createTestPluginRuntime()}>
        <SearchDocumentView hit={HIT} document={DOCUMENT} loading={false} error={null} width={width} height={height} focused />
      </TestPaneProvider>,
      { width, height },
    );
  });
  await settleFrame(tui.setup(), 6);
  return tui.frame().split("\n");
}

/**
 * The page arrives as one wall: the reader has to drop its chrome, keep lines
 * to a reading measure whatever the pane's width, and put air between
 * paragraphs, which is the whole point of it and easy to undo by passing the
 * pane width through somewhere.
 */
test("a wide pane sets the story in a centred column of short lines with blank rows between paragraphs", async () => {
  const rows = await renderReader(140, 60);
  const frame = rows.join("\n");
  expect(frame).toContain("Chip Stocks Cool After Record Run");
  for (const chrome of ["News provided by", "Share this article", "Share to X", "/Wirefeed/", "HALIFAX"]) {
    expect(frame).not.toContain(chrome);
  }
  // The scrollbar holds the last column; the text column is centred in the rest.
  const text = rows.map((row) => row.slice(0, 139).trimEnd()).filter((row) => row.trim().length > 0);
  const left = Math.min(...text.map((row) => row.length - row.trimStart().length));
  const right = Math.max(...text.map((row) => row.length));
  expect(right - left).toBeLessThanOrEqual(72);
  expect(left).toBeGreaterThanOrEqual(30);
  // Paragraphs of the one long block come out apart, each a few lines.
  const runs = rows.map((row) => row.trim().length > 0).reduce<number[]>((acc, filled, index, all) => {
    if (filled && !all[index - 1]) acc.push(1);
    else if (filled) acc[acc.length - 1]! += 1;
    return acc;
  }, []);
  expect(runs.length).toBeGreaterThan(5);
  expect(Math.max(...runs)).toBeLessThanOrEqual(6);
});

test("a long story shows about a screen and keeps the rest behind Read more, which paging opens", async () => {
  const rows = await renderReader(90, 24);
  let frame = rows.join("\n");
  expect(frame).toContain("Read more");
  expect(frame).not.toContain("Pellam Devices plc");
  for (let press = 0; press < 8 && !tui.frame().includes("Pellam Devices plc"); press += 1) {
    await tui.emitKeypress({ name: "space" });
    await settleFrame(tui.setup(), 4);
  }
  frame = tui.frame();
  expect(frame).toContain("Pellam Devices plc (NASDAQ: TK3)");
  expect(frame).not.toContain("Read more");
});
