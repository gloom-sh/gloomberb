import { expect, test } from "bun:test";
import { act } from "react";
import type { CloudTweetPayload, CloudTweetSearchResponse } from "../../../api-client";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { TweetSearchTable } from "./table";

const tui = createOpenTuiTestHarness();
const runtime = createTestPluginRuntime();

function tweet(index: number): CloudTweetPayload {
  return {
    id: `tweet-${index}`,
    url: `https://x.com/desk/status/${index}`,
    text: `DESK NOTE ${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 1) - index * 60_000).toISOString(),
    lang: "en",
    isReply: false,
    author: { id: "u1", userName: "desk", name: "Desk" },
    // Descending so the default views sort keeps the page order.
    metrics: { retweets: 0, replies: 0, likes: 0, quotes: 0, views: 10_000 - index, bookmarks: 0 },
  } as CloudTweetPayload;
}

function response(tweets: CloudTweetPayload[], hasMore: boolean): CloudTweetSearchResponse {
  return {
    query: "$AAPL",
    queryType: "Latest",
    since: "2026-07-18T00:00:00.000Z",
    until: "2026-08-01T00:00:00.000Z",
    limit: 50,
    hasMore,
    hours: 336,
    cached: false,
    cacheTtlMs: 120_000,
    asOf: "2026-08-01T00:00:00.000Z",
    tweets,
  } as CloudTweetSearchResponse;
}

async function frames() {
  for (let index = 0; index < 6; index++) {
    await act(async () => { await Bun.sleep(5); await tui.setup().renderOnce(); });
  }
}

async function mountFeed(
  requestKey: string,
  load: (offset: number) => Promise<CloudTweetSearchResponse>,
) {
  const config = createTestPaneConfig("/tmp/gloom-tweet-table-test/unused-data", {
    instanceId: "tweets:test", paneId: "twitter-feed", binding: { kind: "none" },
  });
  const state = createInitialState(config);
  state.focusedPaneId = "tweets:test";
  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId="tweets:test" pluginId="gloomberb-cloud" runtime={runtime}>
        <PaneFooterProvider>{() => (
          <Box width={80} height={20}>
            <TweetSearchTable
              focused
              width={80}
              height={20}
              requestKey={requestKey}
              footerId={requestKey}
              load={load}
            />
          </Box>
        )}</PaneFooterProvider>
      </TestPaneProvider>,
      { width: 80, height: 20 },
    );
  });
  await frames();
}

async function scrollToEnd(rows: number) {
  await tui.emitKeypress(Array.from({ length: rows }, () => ({ name: "j", sequence: "j" })));
  await frames();
}

test("reading to the end of a feed asks for the tweets below it", async () => {
  const offsets: number[] = [];
  await mountFeed("test:paging", async (offset) => {
    offsets.push(offset);
    return offset === 0
      ? response(Array.from({ length: 50 }, (_, index) => tweet(index)), true)
      : response([tweet(50), tweet(51)], false);
  });
  expect(offsets).toEqual([0]);
  expect(tui.frame()).toContain("DESK NOTE 0");

  await scrollToEnd(50);
  expect(offsets).toEqual([0, 50]);
  await scrollToEnd(5);
  expect(tui.frame()).toContain("DESK NOTE 51");
  // The server reported the end of its window, so scrolling asks for nothing.
  expect(offsets).toEqual([0, 50]);
});

test("a server that ignores the offset ends the feed instead of repeating a page", async () => {
  const offsets: number[] = [];
  const page = Array.from({ length: 50 }, (_, index) => tweet(index));
  await mountFeed("test:no-paging", async (offset) => {
    offsets.push(offset);
    // An older deployment answers the same newest page whatever the offset.
    return response(page, true);
  });

  await scrollToEnd(50);
  expect(offsets).toEqual([0, 50]);
  await scrollToEnd(10);
  expect(offsets).toEqual([0, 50]);
});
