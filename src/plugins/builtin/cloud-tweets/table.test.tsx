import { expect, test } from "bun:test";
import { act } from "react";
import type { CloudTweetPayload, CloudTweetSearchResponse } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { PluginRenderProvider } from "../../../plugins/runtime";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { useTabCursorLink, type TabCursorLink } from "../../../state/app/tab-cursor";
import { createReducerAppStore } from "../../../test-support/app-store";
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

// An open post is the one the user opened: a pin a chart moves meanwhile
// leaves it, its links and its source where they are, and Esc goes back to the
// list without lifting the pin. Back on the list, the selection goes to the
// post at the pin.
test("an open post stays itself while a chart moves the pin, and back on the list the selection follows the pin", async () => {
  // Each post has its own author and link, so the detail and its footer name the post.
  const posts = Array.from({ length: 5 }, (_, index) => ({
    ...tweet(index),
    text: `DESK NOTE ${index} https://desk.example/note-${index}`,
    author: { id: `u${index}`, userName: `desk${index}`, name: `Desk ${index}` },
  }) as CloudTweetPayload);
  const config = createTestPaneConfig("/tmp/gloom-tweet-table-test/unused-data", {
    instanceId: "tweets:pin", paneId: "twitter-feed", binding: { kind: "none" },
  });
  const state = createInitialState(config);
  state.focusedPaneId = "tweets:pin";
  let link: TabCursorLink | undefined;
  function Chart() {
    link = useTabCursorLink("chart");
    return null;
  }
  // The selection and the open post are pane state, so the store runs the app's reducer.
  await act(async () => {
    await tui.render(
      <AppContext value={createReducerAppStore(state)}>
        <PaneInstanceProvider paneId="tweets:pin">
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
            <PaneFooterProvider>{(footer) => (
              <Box width={100} height={20} flexDirection="column">
                <Box width={100} height={19} flexShrink={0}>
                  <Chart />
                  <TweetSearchTable focused width={100} height={19} requestKey="test:pin" footerId="test:pin"
                    load={async () => response(posts, false)} />
                </Box>
                <PaneFooterBar footer={footer} focused width={100} />
              </Box>
            )}</PaneFooterProvider>
          </PluginRenderProvider>
        </PaneInstanceProvider>
      </AppContext>,
      { width: 100, height: 20 },
    );
  });
  await frames();
  const pinAt = async (post: number) => {
    await act(async () => link!.pin!(Date.parse(posts[post]!.createdAt)));
    await frames();
  };
  const press = async (name: string, sequence: string) => {
    await tui.emitKeypress({ name, sequence }, { frames: 2, afterCommit: true });
    await frames();
  };
  /** The post the open detail shows, by its note number, and its link and source, all on screen. */
  const openPost = () => {
    const frame = tui.frame();
    const note = /DESK NOTE (\d)/.exec(frame)?.[1];
    if (note === undefined || frame.includes("Views") === false) return null;
    return { note, link: frame.includes(`desk.example/note-${note}`), source: frame.includes(`@desk${note}`) };
  };
  try {
    await pinAt(2);
    await press("return", "\r");
    expect(openPost()).toEqual({ note: "2", link: true, source: true });

    await pinAt(3);
    expect(openPost()).toEqual({ note: "2", link: true, source: true });
    expect(tui.frame()).not.toContain("DESK NOTE 3");

    // Esc goes back, and the pin stays.
    await press("escape", "\u001b");
    expect(link!.pinned!()).toBe(true);
    expect(tui.frame()).toContain("DESK NOTE 4");

    // The selection went to the post at the pin while the other was open.
    await press("return", "\r");
    expect(openPost()).toEqual({ note: "3", link: true, source: true });
  } finally {
    await act(async () => link?.pin?.(null));
  }
});
